import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  buildClock,
  buildDelay,
  comparatorSignal,
  componentDifferences,
  componentReference,
  containerFullnessTable,
  convertTime,
  delayLineFor,
  fillTime,
  formatDuration,
  fullnessTable,
  isAchievableDelay,
  itemsForSignal,
  run,
  throughput,
} from "./index";
import {
  COMPONENTS,
  CONTAINERS,
  REDSTONE_VERSIONS,
  TRANSPORTS,
  VERSION_CHANGES,
  componentsForVersion,
  transportsForVersion,
} from "./data";

const LATEST = REDSTONE_VERSIONS[REDSTONE_VERSIONS.length - 1]!;

/* ------------------------------------------------------------------ */
/* unit conversion                                                     */
/* ------------------------------------------------------------------ */

describe("convertTime", () => {
  it("converts game ticks to every other unit at the nominal rate", () => {
    const c = convertTime(8, "gameTicks");
    expect(c.gameTicks).toBe(8);
    expect(c.wholeRedstoneTicks).toBe(4);
    expect(c.nominalSeconds).toBeCloseTo(0.4, 10);
    expect(c.nominalMilliseconds).toBe(400);
    expect(c.realSeconds).toBeCloseTo(0.4, 10);
    expect(c.lagFactor).toBe(1);
  });

  it("treats a redstone tick as exactly two game ticks", () => {
    expect(convertTime(1, "redstoneTicks").gameTicks).toBe(2);
    expect(convertTime(4, "redstoneTicks").gameTicks).toBe(8);
  });

  it("reports odd tick counts as not a whole redstone tick", () => {
    const c = convertTime(3, "gameTicks");
    expect(c.wholeRedstoneTicks).toBeNull();
    expect(c.redstoneTicks).toBe(1.5);
  });

  it("stretches real time on a laggy server but leaves the tick count alone", () => {
    const c = convertTime(1200, "gameTicks", 10);
    expect(c.gameTicks).toBe(1200);
    expect(c.nominalSeconds).toBe(60);
    expect(c.realSeconds).toBe(120);
    expect(c.lagFactor).toBe(2);
  });

  it("rounds sub-tick input to the whole tick the game would schedule", () => {
    // 0.37 s is 7.4 ticks; the game cannot schedule a fraction of a tick.
    expect(convertTime(0.37, "seconds").gameTicks).toBeCloseTo(7.4, 6);
    expect(convertTime(0.35, "seconds").wholeRedstoneTicks).toBeNull();
  });

  it("converts hours and minutes", () => {
    expect(convertTime(1, "hours").gameTicks).toBe(72_000);
    expect(convertTime(1, "minutes").gameTicks).toBe(1200);
  });

  it("rejects a negative duration, a non-number, and an unknown unit", () => {
    expect(() => convertTime(-1, "gameTicks")).toThrow(ToolError);
    expect(() => convertTime(Number.NaN, "gameTicks")).toThrow(ToolError);
    // @ts-expect-error deliberately bad unit
    expect(() => convertTime(1, "fortnights")).toThrow(ToolError);
  });

  it("rejects an impossible server tick rate", () => {
    expect(() => convertTime(20, "gameTicks", 0)).toThrow(ToolError);
    expect(() => convertTime(20, "gameTicks", 5000)).toThrow(ToolError);
  });
});

describe("formatDuration", () => {
  it("formats without a dash anywhere", () => {
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(0.4)).toBe("0.4 s");
    expect(formatDuration(64.05)).toBe("1 min 4.05 s");
    expect(formatDuration(8000)).toBe("2 h 13 min 20 s");
    expect(formatDuration(3600)).toBe("1 h");
  });
});

/* ------------------------------------------------------------------ */
/* delay line builder                                                  */
/* ------------------------------------------------------------------ */

describe("buildDelay", () => {
  it("knows which delays are achievable at all", () => {
    expect(isAchievableDelay(0)).toBe(true);
    expect(isAchievableDelay(2)).toBe(true);
    expect(isAchievableDelay(3)).toBe(false);
    expect(isAchievableDelay(8)).toBe(true);
    expect(isAchievableDelay(2.5)).toBe(false);
  });

  it("uses one repeater per delay step up to 8 game ticks", () => {
    for (const [ticks, setting] of [
      [2, 1],
      [4, 2],
      [6, 3],
      [8, 4],
    ] as const) {
      const line = delayLineFor(ticks);
      expect(line.componentCount).toBe(1);
      expect(line.repeaterSettings).toEqual([setting]);
    }
  });

  it("packs longer delays into the fewest repeaters", () => {
    const line = delayLineFor(30);
    expect(line.componentCount).toBe(4);
    expect(line.repeaterSettings).toEqual([4, 4, 4, 3]);
    expect(line.repeaterSettings.reduce((a, b) => a + b * 2, 0)).toBe(30);
    expect(line.comparatorOnlyCount).toBe(15);
  });

  it("always meets the ceil(ticks / 8) lower bound", () => {
    for (let ticks = 2; ticks <= 400; ticks += 2) {
      const line = delayLineFor(ticks);
      expect(line.componentCount).toBe(Math.ceil(ticks / 8));
      expect(line.gameTicks).toBe(ticks);
    }
  });

  it("hits an even target exactly", () => {
    const s = buildDelay(10);
    expect(s.exact).not.toBeNull();
    expect(s.exact!.gameTicks).toBe(10);
    expect(s.exact!.componentCount).toBe(2);
  });

  it("brackets an odd target instead of pretending it works", () => {
    const s = buildDelay(7);
    expect(s.exact).toBeNull();
    expect(s.below!.gameTicks).toBe(6);
    expect(s.above!.gameTicks).toBe(8);
    expect(s.note).toContain("odd");
  });

  it("treats zero as a straight wire with no components", () => {
    const s = buildDelay(0);
    expect(s.exact!.componentCount).toBe(0);
    expect(s.exact!.gameTicks).toBe(0);
  });

  it("brackets 1 tick with a wire and one repeater", () => {
    const s = buildDelay(1);
    expect(s.exact).toBeNull();
    expect(s.below!.gameTicks).toBe(0);
    expect(s.above!.gameTicks).toBe(2);
  });

  it("refuses negative and absurd targets", () => {
    expect(() => buildDelay(-2)).toThrow(ToolError);
    expect(() => buildDelay(1_000_000)).toThrow(ToolError);
    expect(() => delayLineFor(3)).toThrow(ToolError);
  });
});

/* ------------------------------------------------------------------ */
/* clocks                                                              */
/* ------------------------------------------------------------------ */

describe("buildClock", () => {
  it("builds a repeater loop clock whose period is twice the loop delay", () => {
    const s = buildClock(40, "repeater-loop", LATEST);
    expect(s.exact).not.toBeNull();
    expect(s.exact!.periodGameTicks).toBe(40);
    expect(s.exact!.onGameTicks).toBe(20);
    expect(s.exact!.line!.gameTicks).toBe(20);
    expect(s.exact!.pulsesPerMinute).toBe(30);
  });

  it("brackets a repeater loop period that is not a multiple of 4", () => {
    const s = buildClock(30, "repeater-loop", LATEST);
    expect(s.exact).toBeNull();
    expect(s.below!.periodGameTicks).toBe(28);
    expect(s.above!.periodGameTicks).toBe(32);
  });

  it("sizes an item clock from the hopper cooldown", () => {
    const s = buildClock(160, "item-clock", LATEST);
    expect(s.exact).not.toBeNull();
    // 160 ticks / (2 x 8 ticks per transfer) = 10 items shuttling.
    expect(s.exact!.items).toBe(10);
  });

  it("brackets an item clock period that is not a multiple of 16", () => {
    const s = buildClock(100, "item-clock", LATEST);
    expect(s.exact).toBeNull();
    expect(s.below!.periodGameTicks).toBe(96);
    expect(s.above!.periodGameTicks).toBe(112);
  });

  it("rejects a period of zero, an absurd period, and an unknown version", () => {
    expect(() => buildClock(0, "repeater-loop", LATEST)).toThrow(ToolError);
    expect(() => buildClock(10_000_000, "repeater-loop", LATEST)).toThrow(ToolError);
    expect(() => buildClock(40, "repeater-loop", "1.7.10")).toThrow(ToolError);
  });
});

/* ------------------------------------------------------------------ */
/* comparator container fullness                                       */
/* ------------------------------------------------------------------ */

describe("comparatorSignal", () => {
  it("outputs 0 for an empty container and 15 for a full one", () => {
    expect(comparatorSignal(0, 54, 64)).toBe(0);
    expect(comparatorSignal(54 * 64, 54, 64)).toBe(15);
  });

  it("outputs 1 for a single item, however large the container", () => {
    expect(comparatorSignal(1, 54, 64)).toBe(1);
    expect(comparatorSignal(1, 27, 64)).toBe(1);
    expect(comparatorSignal(1, 5, 64)).toBe(1);
  });

  it("matches the well known double chest thresholds", () => {
    // signal = floor(14 * items / 3456) + 1
    expect(comparatorSignal(1481, 54, 64)).toBe(6);
    expect(comparatorSignal(1482, 54, 64)).toBe(7);
    expect(comparatorSignal(3209, 54, 64)).toBe(13);
    expect(comparatorSignal(3210, 54, 64)).toBe(14);
    expect(comparatorSignal(3455, 54, 64)).toBe(14);
  });

  it("scales with the item's stack size", () => {
    // A hopper full of a stack-1 item (5 slots) is 5 items.
    expect(comparatorSignal(5, 5, 1)).toBe(15);
    expect(comparatorSignal(1, 5, 1)).toBe(3);
    expect(comparatorSignal(1, 5, 16)).toBe(1);
  });

  it("rejects an overfull container and bad counts", () => {
    expect(() => comparatorSignal(3457, 54, 64)).toThrow(ToolError);
    expect(() => comparatorSignal(-1, 54, 64)).toThrow(ToolError);
    expect(() => comparatorSignal(1.5, 54, 64)).toThrow(ToolError);
    expect(() => comparatorSignal(1, 0, 64)).toThrow(ToolError);
    expect(() => comparatorSignal(1, 54, 32)).toThrow(ToolError);
  });
});

describe("fullnessTable", () => {
  it("agrees with the forward formula at every single item count", () => {
    for (const slots of [1, 3, 5, 9, 27, 54]) {
      const table = fullnessTable(slots, 64);
      for (const band of table.bands) {
        if (band.minItems === null) continue;
        expect(comparatorSignal(band.minItems, slots, 64)).toBe(band.signal);
        expect(comparatorSignal(band.maxItems!, slots, 64)).toBe(band.signal);
        if (band.minItems > 0) {
          expect(comparatorSignal(band.minItems - 1, slots, 64)).toBeLessThan(band.signal);
        }
      }
    }
  });

  it("covers every item count exactly once across the bands", () => {
    const table = fullnessTable(27, 64);
    const total = table.bands.reduce((a, b) => a + b.span, 0);
    expect(total).toBe(27 * 64 + 1);
  });

  it("finds the fewest items for a target signal", () => {
    const band = itemsForSignal(7, 54, 64)!;
    expect(band.minItems).toBe(1482);
    expect(band.minItemsAsStacks).toBe("23 stacks plus 10");
    expect(comparatorSignal(band.minItems!, 54, 64)).toBe(7);
    expect(comparatorSignal(band.minItems! - 1, 54, 64)).toBe(6);
  });

  it("reports unreachable signals on a container too small to hit them", () => {
    // A single slot of a stack-1 item can only be empty or full.
    const table = fullnessTable(1, 1);
    expect(table.unreachable).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(itemsForSignal(7, 1, 1)).toBeNull();
  });

  it("rejects impossible container shapes and signals", () => {
    expect(() => fullnessTable(0, 64)).toThrow(ToolError);
    expect(() => fullnessTable(500, 64)).toThrow(ToolError);
    expect(() => itemsForSignal(16, 54, 64)).toThrow(ToolError);
    expect(() => itemsForSignal(-1, 54, 64)).toThrow(ToolError);
  });
});

describe("containerFullnessTable", () => {
  it("resolves a named container to its real slot count", () => {
    const table = containerFullnessTable("double_chest", 64, LATEST);
    expect(table.slots).toBe(54);
    expect(table.capacity).toBe(3456);
    expect(table.container!.label).toContain("chest");
  });

  it("clamps the stack size to what the container allows", () => {
    const table = containerFullnessTable("hopper", 64, LATEST);
    expect(table.slots).toBe(5);
    expect(table.stackSize).toBe(64);
  });

  it("rejects a container that does not exist in the chosen version", () => {
    expect(() => containerFullnessTable("nether_reactor", 64, LATEST)).toThrow(ToolError);
  });
});

/* ------------------------------------------------------------------ */
/* throughput                                                          */
/* ------------------------------------------------------------------ */

describe("throughput", () => {
  it("moves one item every 8 game ticks through a hopper", () => {
    const r = throughput("hopper", { version: LATEST });
    expect(r.ticksPerItem).toBe(8);
    expect(r.itemsPerSecond).toBe(2.5);
    expect(r.itemsPerHour).toBe(9000);
    expect(r.stacksPerHour).toBeCloseTo(140.625, 6);
  });

  it("reproduces the measured hopper cadence: 2 items after 20 ticks, 7 after 60", () => {
    const r = throughput("hopper", { version: LATEST });
    const moved = (ticks: number) => Math.floor(ticks / r.ticksPerItem);
    expect(moved(20)).toBe(2);
    expect(moved(60)).toBe(7);
    expect(moved(8)).toBe(1);
    expect(moved(7)).toBe(0);
  });

  it("scales linearly with parallel lines", () => {
    const one = throughput("hopper", { version: LATEST });
    const five = throughput("hopper", { version: LATEST, lines: 5 });
    expect(five.itemsPerSecond).toBeCloseTo(one.itemsPerSecond * 5, 10);
  });

  it("does not speed up a hopper chain, it only adds latency", () => {
    const single = throughput("hopper", { version: LATEST });
    const chain = throughput("hopper_chain", { version: LATEST, chainLength: 6 });
    expect(chain.itemsPerSecond).toBe(single.itemsPerSecond);
    expect(chain.startupTicks).toBe(48);
  });

  it("moves two items per cooldown from a hopper into another hopper", () => {
    // Both hoppers act: the upper one pushes down and the lower one pulls
    // from the container above it, each on its own 8 tick cooldown.
    const r = throughput("hopper_to_hopper", { version: LATEST });
    expect(r.itemsPerSecond).toBe(5);
    expect(r.ticksPerItem).toBe(4);
  });

  it("moves a whole merged stack per hopper cooldown out of a water stream", () => {
    const r = throughput("water_stream", { version: LATEST });
    expect(r.itemsPerSecond).toBe(160);
    expect(r.ticksPerItem).toBe(0.125);
    const singles = throughput("water_stream", { version: LATEST, stackSize: 1 });
    expect(singles.itemsPerSecond).toBe(2.5);
  });

  it("tracks the hopper minecart pull rate change at 1.20.6", () => {
    expect(throughput("hopper_minecart", { version: "1.16.5" }).itemsPerSecond).toBe(5);
    expect(throughput("hopper_minecart", { version: "1.18.2" }).itemsPerSecond).toBe(5);
    expect(throughput("hopper_minecart", { version: "1.20.6" }).itemsPerSecond).toBe(20);
    expect(throughput("hopper_minecart", { version: LATEST }).itemsPerSecond).toBe(20);
  });

  it("lets a clock set the rate of a dropper and refuses an impossible clock", () => {
    expect(throughput("dropper", { version: LATEST }).itemsPerSecond).toBe(5);
    expect(throughput("dropper", { version: LATEST, clockPeriod: 20 }).itemsPerSecond).toBe(1);
    expect(() => throughput("dropper", { version: LATEST, clockPeriod: 2 })).toThrow(ToolError);
  });

  it("slows down with the server tick rate", () => {
    const laggy = throughput("hopper", { version: LATEST, tps: 10 });
    expect(laggy.itemsPerSecond).toBe(1.25);
  });

  it("rejects unknown transports, bad stack sizes, and silly line counts", () => {
    expect(() => throughput("teleporter", { version: LATEST })).toThrow(ToolError);
    expect(() => throughput("hopper", { version: LATEST, stackSize: 32 })).toThrow(ToolError);
    expect(() => throughput("hopper", { version: LATEST, lines: 5000 })).toThrow(ToolError);
  });

  it("covers every transport in the data set without throwing", () => {
    for (const version of REDSTONE_VERSIONS) {
      for (const t of transportsForVersion(version)) {
        const r = throughput(t.id, { version });
        expect(r.itemsPerSecond).toBeGreaterThan(0);
      }
    }
  });
});

describe("fillTime", () => {
  it("fills a double chest of full stacks through one hopper", () => {
    const f = fillTime("double_chest", "hopper", { version: LATEST });
    expect(f.capacity).toBe(3456);
    expect(f.gameTicks).toBe(3456 * 8);
    expect(f.seconds).toBeCloseTo(1382.4, 6);
  });

  it("splits the work across parallel hoppers", () => {
    const one = fillTime("double_chest", "hopper", { version: LATEST });
    const four = fillTime("double_chest", "hopper", { version: LATEST, lines: 4 });
    expect(four.seconds).toBeCloseTo(one.seconds / 4, 6);
  });

  it("accounts for items that do not stack to 64", () => {
    const f = fillTime("double_chest", "hopper", { version: LATEST, stackSize: 1 });
    expect(f.capacity).toBe(54);
  });
});

/* ------------------------------------------------------------------ */
/* component reference and version data                                */
/* ------------------------------------------------------------------ */

describe("component reference", () => {
  it("returns a sorted table for every supported version", () => {
    for (const version of REDSTONE_VERSIONS) {
      const rows = componentReference(version);
      expect(rows.length).toBeGreaterThan(8);
      for (let i = 1; i < rows.length; i += 1) {
        expect(rows[i]!.delayTicks).toBeGreaterThanOrEqual(rows[i - 1]!.delayTicks);
      }
    }
  });

  it("cites a class for every component and container", () => {
    for (const c of COMPONENTS) {
      expect(c.source.length).toBeGreaterThan(4);
      expect(c.note.length).toBeGreaterThan(4);
    }
    for (const c of CONTAINERS) expect(c.source.length).toBeGreaterThan(4);
    for (const t of TRANSPORTS) expect(t.source.length).toBeGreaterThan(4);
  });

  it("never lists a component in a version that does not have it", () => {
    for (const version of REDSTONE_VERSIONS) {
      for (const c of componentsForVersion(version)) {
        expect(c.availableIn ?? REDSTONE_VERSIONS).toContain(version);
      }
    }
  });

  it("reports the version boundaries as component differences", () => {
    const diffs = componentDifferences();
    for (const d of diffs) {
      expect(d.perVersion).toHaveLength(REDSTONE_VERSIONS.length);
    }
    expect(VERSION_CHANGES.length).toBeGreaterThan(0);
    for (const change of VERSION_CHANGES) {
      expect(REDSTONE_VERSIONS).toContain(change.version);
      expect(change.source.length).toBeGreaterThan(4);
    }
  });

  it("rejects an unknown version", () => {
    expect(() => componentReference("1.7.10")).toThrow(ToolError);
  });
});

/* ------------------------------------------------------------------ */
/* copy rules                                                          */
/* ------------------------------------------------------------------ */

describe("prose", () => {
  it("uses no em dashes or en dashes anywhere in the data set", () => {
    const strings: string[] = [];
    for (const c of COMPONENTS) strings.push(c.label, c.note, c.group, ...c.synonyms);
    for (const c of CONTAINERS) strings.push(c.label, c.note, ...c.synonyms);
    for (const t of TRANSPORTS) strings.push(t.label, t.note, ...t.synonyms);
    for (const v of VERSION_CHANGES) strings.push(v.summary);
    for (const s of strings) expect(s).not.toMatch(/[–—]/);
  });
});

/* ------------------------------------------------------------------ */
/* run() surface                                                       */
/* ------------------------------------------------------------------ */

describe("run", () => {
  it("converts by default", () => {
    const out = run('{"mode":"convert","value":8,"unit":"gameTicks"}');
    expect(out["Game ticks"]).toBe("8");
    expect(out["Redstone ticks"]).toBe("4");
  });

  it("plans a delay line", () => {
    const out = run('{"mode":"delay","ticks":30}');
    expect(out.Exact).toContain("30 game ticks");
    expect(out.Exact).toContain("4 components");
  });

  it("plans a clock", () => {
    const out = run('{"mode":"clock","ticks":40,"clock":"repeater-loop"}');
    expect(out.Exact).toContain("40 game ticks");
  });

  it("reports throughput and a fill time", () => {
    const out = run('{"mode":"throughput","transport":"hopper","container":"double_chest"}');
    expect(out["Items per hour"]).toBe("9000");
    expect(out["Time to fill a Double chest"]).toContain("3456 items");
  });

  it("answers the fullness question in both directions", () => {
    const forward = run('{"mode":"signal","container":"double_chest","items":1482}');
    expect(forward["Signal strength"]).toBe("7");
    const inverse = run('{"mode":"signal","container":"double_chest","signal":7}');
    expect(inverse["Fewest items"]).toContain("1482");
  });

  it("lists the component reference", () => {
    const out = run('{"mode":"components"}', { version: LATEST });
    expect(Object.keys(out).length).toBeGreaterThan(8);
  });

  it("rejects empty input, bad JSON, and an unknown mode", () => {
    expect(() => run("")).toThrow(ToolError);
    expect(() => run("{nope}")).toThrow(ToolError);
    expect(() => run('{"mode":"teleport"}')).toThrow(ToolError);
  });

  it("rejects an unknown version option", () => {
    expect(() => run('{"mode":"convert","value":1}', { version: "1.7.10" })).toThrow(ToolError);
  });
});
