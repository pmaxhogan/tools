import { describe, expect, it } from "vitest";
import {
  COMMON_DURATIONS,
  DAY_TIME_MARKERS,
  msptToTps,
  nearestMarker,
  redstoneTicksToGameTicks,
  run,
  secondsToTicks,
  ticksToRedstoneTicks,
  ticksToSeconds,
  timeOfDay,
  TICKS_PER_DAY,
  TICKS_PER_SECOND,
  tpsToMspt,
} from "./index";
import { ToolError } from "../types";

describe("ticks and seconds", () => {
  it("converts ticks to seconds at 20 TPS", () => {
    expect(ticksToSeconds(20)).toBe(1);
    expect(ticksToSeconds(24000)).toBe(1200);
  });

  it("round trips seconds to ticks", () => {
    expect(secondsToTicks(60)).toBe(1200);
    expect(secondsToTicks(ticksToSeconds(140))).toBe(140);
  });
});

describe("redstone ticks", () => {
  it("one redstone tick is 2 game ticks", () => {
    expect(redstoneTicksToGameTicks(1)).toBe(2);
    expect(ticksToRedstoneTicks(2)).toBe(1);
  });

  it("a repeater's max 4 redstone tick delay is 8 game ticks (0.4s)", () => {
    const gameTicks = redstoneTicksToGameTicks(4);
    expect(gameTicks).toBe(8);
    expect(ticksToSeconds(gameTicks)).toBeCloseTo(0.4, 5);
  });
});

describe("tps and mspt", () => {
  it("20 TPS is 50ms per tick", () => {
    expect(tpsToMspt(20)).toBe(50);
  });

  it("50ms per tick round trips to 20 TPS", () => {
    expect(msptToTps(50)).toBe(20);
  });

  it("caps TPS at 20 even when ticks run faster than 50ms", () => {
    expect(msptToTps(25)).toBe(20);
  });

  it("throws for non-positive input", () => {
    expect(() => tpsToMspt(0)).toThrow(ToolError);
    expect(() => msptToTps(-5)).toThrow(ToolError);
  });
});

describe("day cycle", () => {
  it("named markers are in ascending tick order", () => {
    const ticks = DAY_TIME_MARKERS.map((m) => m.ticks);
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
  });

  it("wraps time of day past 24000 ticks", () => {
    expect(timeOfDay(24000)).toBe(0);
    expect(timeOfDay(25000)).toBe(1000);
  });

  it("wraps negative time of day into range", () => {
    expect(timeOfDay(-1000)).toBe(TICKS_PER_DAY - 1000);
  });

  it("finds the nearest marker at or before a given tick", () => {
    const { marker, ticksSince } = nearestMarker(6500);
    expect(marker.label).toBe("noon");
    expect(ticksSince).toBe(500);
  });

  it("finds midnight for the marker at exactly 18000", () => {
    const { marker, ticksSince } = nearestMarker(18000);
    expect(marker.label).toBe("midnight");
    expect(ticksSince).toBe(0);
  });
});

describe("COMMON_DURATIONS", () => {
  it("includes a full in-game day at 24000 ticks", () => {
    const day = COMMON_DURATIONS.find((d) => d.label.includes("in-game day, real time"));
    expect(day?.ticks).toBe(TICKS_PER_DAY);
  });
});

describe("run", () => {
  it("converts ticks to time", () => {
    const out = run(undefined, {
      mode: "ticks-to-time",
      ticks: 1200,
      seconds: 0,
      redstoneTicks: 0,
      tps: 20,
      mspt: 50,
      currentTime: 0,
      addTicks: 0,
    });
    expect(out.Seconds).toBe("60");
    expect(out.Minutes).toBe("1");
  });

  it("converts time to ticks", () => {
    const out = run(undefined, {
      mode: "time-to-ticks",
      ticks: 0,
      seconds: 60,
      redstoneTicks: 0,
      tps: 20,
      mspt: 50,
      currentTime: 0,
      addTicks: 0,
    });
    expect(out.Ticks).toBe("1,200");
  });

  it("reports the day cycle marker", () => {
    const out = run(undefined, {
      mode: "day-cycle",
      ticks: 0,
      seconds: 0,
      redstoneTicks: 0,
      tps: 20,
      mspt: 50,
      currentTime: 13500,
      addTicks: 0,
    });
    expect(out["Nearest marker"]).toContain("night");
  });

  it("reports /time add results", () => {
    const out = run(undefined, {
      mode: "time-add",
      ticks: 0,
      seconds: 0,
      redstoneTicks: 0,
      tps: 20,
      mspt: 50,
      currentTime: 23000,
      addTicks: 2000,
    });
    expect(out["Resulting time of day"]).toBe("1000");
  });

  it("reports TPS to MSPT", () => {
    const out = run(undefined, {
      mode: "tps-to-mspt",
      ticks: 0,
      seconds: 0,
      redstoneTicks: 0,
      tps: 20,
      mspt: 50,
      currentTime: 0,
      addTicks: 0,
    });
    expect(out.MSPT).toBe("50");
    expect(out["Server health"]).toBe("Running at full speed");
  });

  it("reports MSPT to TPS", () => {
    const out = run(undefined, {
      mode: "mspt-to-tps",
      ticks: 0,
      seconds: 0,
      redstoneTicks: 0,
      tps: 20,
      mspt: 100,
      currentTime: 0,
      addTicks: 0,
    });
    expect(out.TPS).toBe("10");
    expect(out["Server health"]).toContain("Behind schedule");
  });

  it("reports the common durations table", () => {
    const out = run(undefined, {
      mode: "durations",
      ticks: 0,
      seconds: 0,
      redstoneTicks: 0,
      tps: 20,
      mspt: 50,
      currentTime: 0,
      addTicks: 0,
    });
    expect(Object.keys(out).length).toBe(COMMON_DURATIONS.length);
  });

  it("throws for an unknown mode", () => {
    expect(() =>
      run(undefined, {
        mode: "nope",
        ticks: 0,
        seconds: 0,
        redstoneTicks: 0,
        tps: 20,
        mspt: 50,
        currentTime: 0,
        addTicks: 0,
      }),
    ).toThrow(ToolError);
  });

  it("throws for a non-finite ticks value", () => {
    expect(() =>
      run(undefined, {
        mode: "ticks-to-time",
        ticks: NaN,
        seconds: 0,
        redstoneTicks: 0,
        tps: 20,
        mspt: 50,
        currentTime: 0,
        addTicks: 0,
      }),
    ).toThrow(ToolError);
  });
});

// TICKS_PER_SECOND stays imported so the "known constant" is asserted directly.
describe("TICKS_PER_SECOND", () => {
  it("is 20", () => {
    expect(TICKS_PER_SECOND).toBe(20);
  });
});
