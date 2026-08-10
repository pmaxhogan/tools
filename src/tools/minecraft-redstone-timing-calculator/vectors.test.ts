import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { componentById, REDSTONE_VERSIONS, transportById, type VersionId } from "./data";

/**
 * Golden-vector suite for the measured redstone timings.
 *
 * Two file shapes exist under mc-pipeline/vectors/redstone/, and both are
 * asserted exactly. Which one a version gets is decided by the harness, not by
 * this suite, so the loop below walks whatever files are on disk and dispatches
 * on the `measured` flag each file states about itself.
 *
 * `rcon-e2e` files (`measured: true`) carry `cases`.
 * mc-pipeline/07-harness-sim.mjs boots a real dedicated server, freezes the
 * game, and steps it exactly one tick at a time with `tick freeze` plus `tick
 * step 1`, sampling a block state or a container count after every single tick.
 * Tick 1 in a series is the first tick after the setup command that starts the
 * case. Those measurements are the authority: where a measurement and the model
 * disagree, the model is wrong. What each case pins down:
 *
 * - hopper-to-chest / hopper-to-furnace: the destination gains one item every
 *   8 game ticks, the hopper transfer cooldown. The whole 60 sample series is
 *   checked, not just the transitions.
 * - hopper-to-hopper: the destination gains TWO items every 8 ticks, because
 *   both hoppers act on their own cooldowns: the upper one pushes down and the
 *   lower one separately pulls from the container above it. This is the
 *   measurement that forced the model to carry a separate hopper-into-hopper
 *   rate rather than reusing the 2.5 items a second figure.
 * - dropper-fire-delay / dispenser-fire-delay: 4 ticks after a rising edge.
 * - repeater-delay-1 through 4: both edges land at 2 times the delay setting.
 *   The readback is taken off the diode's own `powered` state; an earlier
 *   harness revision probed a downstream redstone lamp, whose asymmetric turn
 *   off contaminated every falling edge, and that revision is gone.
 * - comparator-compare: the same, with a fixed 2 tick delay.
 * - redstone-lamp: lit on the first stepped tick, dark 4 ticks after the power
 *   goes away. This is the asymmetry that made the lamp unusable as a probe,
 *   measured directly so the model carries the real number.
 * - observer-pulse: powers up 2 ticks after the watched block changes and
 *   stays powered for 2 ticks.
 * - piston: the head appears 2 ticks after it starts moving and disappears on
 *   the tick the retraction block event is drained.
 *
 * `source-derived` files (`measured: false`) carry `sourceConstants` instead.
 * Versions before the `tick` command family (1.16.5 and 1.18.2 have no `tick
 * freeze` or `tick step`) cannot be stepped one tick at a time over RCON at
 * all, so nothing can be measured and the harness reads the scheduling
 * constants out of the decompiled source of the class recorded next to each
 * value. Those are asserted just as hard: they are an INDEPENDENT reading of
 * the same Java by a different agent, so a mismatch means one of the two
 * readings is wrong.
 *
 * Nothing here is conditional or tolerated. Both shapes assert that the set of
 * cases or constants they carry is exactly the set this suite cross-checks, so
 * a case that stops being emitted fails just as loudly as one that disagrees.
 */

const VECTORS_DIR = fileURLToPath(new URL("../../../mc-pipeline/vectors/redstone/", import.meta.url));

interface Sample {
  tick: number;
  value: number | boolean;
}

interface Transition {
  tick: number;
  from: number | boolean;
  to: number | boolean;
}

interface VectorCase {
  case: string;
  description: string;
  ticks?: number;
  series?: Sample[];
  transitions?: Transition[];
  repeaterDelaySetting?: number | null;
  facing?: string;
  risingSeries?: Sample[];
  risingTransitions?: Transition[];
  fallingSeries?: Sample[];
  fallingTransitions?: Transition[];
  extendSeries?: unknown[];
  extendedAtTick?: number | null;
  retractSeries?: unknown[];
  retractedAtTick?: number | null;
}

/** Every leaf constant states its value, the class it came from, and a note. */
interface ConstantLeaf {
  value: number;
  class: string;
  note: string | null;
}

interface SourceConstant {
  name: string;
  ticks?: ConstantLeaf;
  progressPerTick?: ConstantLeaf;
}

interface VectorFile {
  version: string;
  generated?: string;
  serverJarSha1?: string;
  method: string;
  measured: boolean;
  note?: string;
  cases?: VectorCase[];
  sourceConstants?: SourceConstant[];
}

const files = existsSync(VECTORS_DIR)
  ? readdirSync(VECTORS_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort()
  : [];

const parsed = files.map((file) => {
  const vec = JSON.parse(readFileSync(VECTORS_DIR + file, "utf8")) as VectorFile;
  return { file, version: vec.version ?? file.replace(/\.json$/, ""), vec };
});

/** Every case name a measured file is expected to carry. */
const EXPECTED_CASES = [
  "hopper-to-chest",
  "hopper-to-hopper",
  "hopper-to-furnace",
  "dropper-fire-delay",
  "dispenser-fire-delay",
  "repeater-delay-1",
  "repeater-delay-2",
  "repeater-delay-3",
  "repeater-delay-4",
  "comparator-compare",
  "redstone-lamp",
  "observer-pulse",
  "piston",
];

/** Every constant name a source-derived file is expected to carry. */
const EXPECTED_CONSTANTS = [
  "hopper-transfer-cooldown",
  "dispenser-and-dropper-fire-delay",
  "repeater-ticks-per-delay-setting",
  "comparator-delay",
  "observer-schedule-delay",
  "piston-movement",
];

/** Pull a leaf constant, failing loudly if the shape drifts back to a number. */
function leafOf(c: SourceConstant, key: "ticks" | "progressPerTick"): ConstantLeaf {
  const leaf = c[key];
  expect(leaf, `${c.name} has no ${key} leaf`).toBeTruthy();
  expect(typeof leaf!.value, `${c.name}.${key}.value must be a number`).toBe("number");
  expect(typeof leaf!.class, `${c.name}.${key}.class must be a string`).toBe("string");
  return leaf!;
}

it("has at least one vector version on disk", () => {
  expect(files.length).toBeGreaterThan(0);
});

for (const { file, version, vec } of parsed) {
  const known = (REDSTONE_VERSIONS as readonly string[]).includes(version);

  describe(`redstone vectors ${version} (${vec.method})`, () => {
    it("is a version this tool ships data for", () => {
      expect(REDSTONE_VERSIONS, `${file} is for a version with no data module`).toContain(version);
    });

    it("agrees with itself about whether it was measured", () => {
      expect(typeof vec.measured, `${file} has no measured flag`).toBe("boolean");
      expect(vec.measured).toBe(vec.method === "rcon-e2e");
      expect(Boolean(vec.cases?.length), `${file}: cases present`).toBe(vec.measured);
      expect(Boolean(vec.sourceConstants?.length), `${file}: sourceConstants present`).toBe(
        !vec.measured,
      );
    });

    if (!known) return;

    const v = version as VersionId;
    const hopperCooldown = transportById(v, "hopper").ticksPerItem;
    const hopperPair = transportById(v, "hopper_to_hopper").itemsPerTransfer;
    const dropperDelay = componentById(v, "dropper").delayTicks;
    const dispenserDelay = componentById(v, "dispenser").delayTicks;
    const repeater = componentById(v, "repeater");
    const comparatorDelay = componentById(v, "comparator").delayTicks;
    const observer = componentById(v, "observer");
    const pistonMove = componentById(v, "piston").delayTicks;
    const lamp = componentById(v, "redstone_lamp");

    /* ------------------------- measured cases ------------------------- */

    if (vec.measured) {
      const byCase = new Map((vec.cases ?? []).map((c) => [c.case, c]));
      const mustGet = (name: string): VectorCase => {
        const c = byCase.get(name);
        if (!c) throw new Error(`${file} has no case "${name}"`);
        return c;
      };

      it("carries exactly the cases this suite cross-checks", () => {
        expect([...byCase.keys()].sort()).toEqual([...EXPECTED_CASES].sort());
      });

      it("the hopper into hopper rate is a plain item count", () => {
        expect(typeof hopperPair).toBe("number");
      });

      for (const [caseName, step] of [
        ["hopper-to-chest", 1],
        ["hopper-to-furnace", 1],
        ["hopper-to-hopper", hopperPair as number],
      ] as const) {
        it(`${caseName}: ${step} item every ${hopperCooldown} game ticks`, () => {
          const c = mustGet(caseName);
          const series = c.series!;
          const first = c.transitions![0]!.tick;
          for (const s of series) {
            const moved = s.tick < first ? 0 : Math.floor((s.tick - first) / hopperCooldown) + 1;
            expect({ tick: s.tick, value: s.value }).toEqual({
              tick: s.tick,
              value: moved * step,
            });
          }
          const ticks = c.transitions!.map((t) => t.tick);
          expect(ticks.length).toBeGreaterThan(1);
          for (let i = 1; i < ticks.length; i += 1) {
            expect(ticks[i]! - ticks[i - 1]!).toBe(hopperCooldown);
          }
        });
      }

      for (const [caseName, expected] of [
        ["dropper-fire-delay", dropperDelay],
        ["dispenser-fire-delay", dispenserDelay],
      ] as const) {
        it(`${caseName}: fires ${expected} game ticks after the rising edge`, () => {
          const ts = mustGet(caseName).transitions ?? [];
          expect(ts).toHaveLength(1);
          expect(ts[0]!.tick).toBe(expected);
        });
      }

      for (const setting of [1, 2, 3, 4]) {
        it(`repeater on ${setting}: ${setting * 2} game ticks each way`, () => {
          const c = mustGet(`repeater-delay-${setting}`);
          expect(c.repeaterDelaySetting).toBe(setting);
          const expected = setting * 2;
          expect(expected).toBeLessThanOrEqual(repeater.delayRange![1]);
          const rising = c.risingTransitions ?? [];
          const falling = c.fallingTransitions ?? [];
          expect(rising).toHaveLength(1);
          expect(falling).toHaveLength(1);
          // Read off the diode's own powered state, so both edges carry the
          // repeater's delay and nothing else.
          expect(rising[0]!.tick).toBe(expected);
          expect(falling[0]!.tick).toBe(expected);
        });
      }

      it(`comparator: ${comparatorDelay} game ticks each way`, () => {
        const c = mustGet("comparator-compare");
        const rising = c.risingTransitions ?? [];
        const falling = c.fallingTransitions ?? [];
        expect(rising).toHaveLength(1);
        expect(falling).toHaveLength(1);
        expect(rising[0]!.tick).toBe(comparatorDelay);
        expect(falling[0]!.tick).toBe(comparatorDelay);
      });

      it(`redstone lamp: instant on, ${lamp.delayTicks} game ticks to go dark`, () => {
        const c = mustGet("redstone-lamp");
        expect(c.risingTransitions![0]!.tick).toBe(1);
        expect(c.fallingTransitions![0]!.tick).toBe(lamp.delayTicks);
      });

      it(`observer: arms in ${observer.delayTicks} ticks, ${observer.pulseTicks} tick pulse`, () => {
        const ts = mustGet("observer-pulse").transitions ?? [];
        expect(ts).toHaveLength(2);
        expect(ts[0]!.to).toBe(true);
        expect(ts[1]!.to).toBe(false);
        expect(ts[0]!.tick).toBe(observer.delayTicks);
        expect(ts[1]!.tick - ts[0]!.tick).toBe(observer.pulseTicks);
      });

      it(`piston: head travels for ${pistonMove} game ticks`, () => {
        // Powering and unpowering both queue a block event, drained on the
        // first stepped tick: retraction pulls the head that same tick, and
        // extension only shows a head once the move finishes 2 ticks later.
        const c = mustGet("piston");
        expect(c.retractedAtTick).toBe(1);
        expect(c.extendedAtTick).toBe(1 + pistonMove);
      });
    }

    /* --------------------- source-derived constants -------------------- */

    if (!vec.measured) {
      const byName = new Map((vec.sourceConstants ?? []).map((s) => [s.name, s]));
      const mustGet = (name: string): SourceConstant => {
        const s = byName.get(name);
        if (!s) throw new Error(`${file} has no constant "${name}"`);
        return s;
      };

      it("states exactly the constants this suite cross-checks", () => {
        expect([...byName.keys()].sort()).toEqual([...EXPECTED_CONSTANTS].sort());
      });

      it("HopperBlockEntity: hopper transfer cooldown agrees with the tool", () => {
        const t = leafOf(mustGet("hopper-transfer-cooldown"), "ticks");
        expect(t.class).toBe("HopperBlockEntity");
        expect(t.value).toBe(hopperCooldown);
      });

      it("DispenserBlock: dropper and dispenser delay agrees with the tool", () => {
        const t = leafOf(mustGet("dispenser-and-dropper-fire-delay"), "ticks");
        expect(t.class).toBe("DispenserBlock");
        expect(t.value).toBe(dispenserDelay);
        expect(t.value).toBe(dropperDelay);
      });

      it("RepeaterBlock: game ticks per delay setting agrees with the tool", () => {
        // The harness reads the multiplier in getDelay; the tool stores the
        // resulting range over the four settings.
        const t = leafOf(mustGet("repeater-ticks-per-delay-setting"), "ticks");
        expect(t.class).toBe("RepeaterBlock");
        expect(repeater.delayTicks).toBe(t.value);
        expect(repeater.delayRange![0]).toBe(t.value);
        expect(repeater.delayRange![1]).toBe(t.value * 4);
      });

      it("ComparatorBlock: comparator delay agrees with the tool", () => {
        const t = leafOf(mustGet("comparator-delay"), "ticks");
        expect(t.class).toBe("ComparatorBlock");
        expect(t.value).toBe(comparatorDelay);
      });

      it("ObserverBlock: observer schedule delay agrees with the tool", () => {
        // The same 2 tick schedule both arms the observer and ends its pulse.
        const t = leafOf(mustGet("observer-schedule-delay"), "ticks");
        expect(t.class).toBe("ObserverBlock");
        expect(t.value).toBe(observer.delayTicks);
        expect(t.value).toBe(observer.pulseTicks);
      });

      it("PistonMovingBlockEntity: piston movement duration agrees with the tool", () => {
        const s = mustGet("piston-movement");
        const t = leafOf(s, "ticks");
        const p = leafOf(s, "progressPerTick");
        expect(t.class).toBe("PistonMovingBlockEntity");
        expect(t.value).toBe(pistonMove);
        // A block event driven move, so the duration is the progress step.
        expect(Math.round(1 / p.value)).toBe(pistonMove);
      });
    }
  });
}
