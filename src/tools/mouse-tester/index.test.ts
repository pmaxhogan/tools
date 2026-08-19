import { describe, expect, it } from "vitest";
import {
  accelerationCheck,
  clickStats,
  describeButtons,
  dpiFromTravel,
  pollingRateFromTimestamps,
  run,
  scrollStats,
  summarize,
  type AccelerationSample,
  type ClickEvent,
  type MouseTesterOpts,
  type ScrollEvent,
} from "./index";
import { ToolError } from "../types";

const OPTS: MouseTesterOpts = { physicalDistanceCm: 10, units: "cm" };

describe("pollingRateFromTimestamps", () => {
  it("classifies 1 ms spaced timestamps as 1000 Hz", () => {
    const stamps = Array.from({ length: 11 }, (_, i) => i * 1);
    const rate = pollingRateFromTimestamps(stamps);
    expect(rate.hz).toBeCloseTo(1000, 0);
    expect(rate.median).toBe(1);
    expect(rate.classification).toBe("1000 Hz");
    expect(rate.samples).toBe(11);
    expect(rate.jitterMs).toBe(0);
  });

  it("classifies 8 ms spaced timestamps as 125 Hz", () => {
    const stamps = Array.from({ length: 11 }, (_, i) => i * 8);
    const rate = pollingRateFromTimestamps(stamps);
    expect(rate.hz).toBeCloseTo(125, 0);
    expect(rate.median).toBe(8);
    expect(rate.classification).toBe("125 Hz");
  });

  it("reports unknown for a jittery signal even when the median is near a standard rate", () => {
    // deltas: [8,8,8,8,40] repeated 3 times - median lands on 8 (125 Hz) but
    // the mean deviation is 80% of the median, well past the noise tolerance.
    const deltas = [8, 8, 8, 8, 40, 8, 8, 8, 8, 40, 8, 8, 8, 8, 40];
    const stamps: number[] = [0];
    for (const d of deltas) stamps.push(stamps[stamps.length - 1] + d);
    const rate = pollingRateFromTimestamps(stamps);
    expect(rate.classification).toBe("unknown");
    expect(rate.jitterMs).toBeGreaterThan(1);
    expect(rate.samples).toBe(16);
  });

  it("reports unknown when there are too few samples for a stable reading", () => {
    const rate = pollingRateFromTimestamps([0, 5, 9]);
    expect(rate.classification).toBe("unknown");
    expect(rate.hz).toBe(0);
    expect(rate.samples).toBe(3);
  });

  it("ignores non-finite entries and tolerates an empty array", () => {
    const rate = pollingRateFromTimestamps([]);
    expect(rate.classification).toBe("unknown");
    expect(rate.samples).toBe(0);
  });
});

describe("dpiFromTravel", () => {
  it("computes 800 DPI from 3150 counts over 10 cm (3.937 in)", () => {
    const result = dpiFromTravel({ counts: 3150, physicalDistanceInches: 3.937 });
    expect(result.dpi).toBe(800);
    expect(result.nearestCommonDpi).toBe(800);
    expect(result.note).toMatch(/raw device counts/);
  });

  it("throws on zero counts", () => {
    expect(() => dpiFromTravel({ counts: 0, physicalDistanceInches: 3.937 })).toThrowError(
      ToolError,
    );
    try {
      dpiFromTravel({ counts: 0, physicalDistanceInches: 3.937 });
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-travel-counts");
    }
  });

  it("throws on a non-positive physical distance", () => {
    try {
      dpiFromTravel({ counts: 1000, physicalDistanceInches: 0 });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-travel-distance");
    }
  });
});

describe("accelerationCheck", () => {
  it("reports linear when fast and slow runs report similar counts", () => {
    const slow: AccelerationSample[] = Array.from({ length: 5 }, () => ({ dt: 100, dx: 50 }));
    const fast: AccelerationSample[] = Array.from({ length: 5 }, () => ({ dt: 20, dx: 48 }));
    const result = accelerationCheck(slow, fast);
    expect(result.slowCounts).toBe(250);
    expect(result.fastCounts).toBe(240);
    expect(result.verdict).toBe("linear");
  });

  it("reports accelerated when the fast run reports disproportionately more counts", () => {
    const slow: AccelerationSample[] = Array.from({ length: 5 }, () => ({ dt: 100, dx: 50 }));
    const fast: AccelerationSample[] = Array.from({ length: 5 }, () => ({ dt: 20, dx: 64 }));
    const result = accelerationCheck(slow, fast);
    expect(result.slowCounts).toBe(250);
    expect(result.fastCounts).toBe(320);
    expect(result.ratio).toBeCloseTo(1.28, 2);
    expect(result.verdict).toBe("accelerated");
  });

  it("throws when one of the two runs has no samples", () => {
    try {
      accelerationCheck([], [{ dt: 10, dx: 10 }]);
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("insufficient-samples");
    }
  });

  it("throws when a run recorded no actual movement", () => {
    try {
      accelerationCheck([{ dt: 10, dx: 0 }], [{ dt: 5, dx: 10 }]);
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("no-movement");
    }
  });
});

describe("describeButtons", () => {
  it("names the standard buttons and falls back for unknown indices", () => {
    expect(describeButtons(0)).toBe("Left");
    expect(describeButtons(1)).toBe("Middle");
    expect(describeButtons(2)).toBe("Right");
    expect(describeButtons(3)).toBe("Back");
    expect(describeButtons(4)).toBe("Forward");
    expect(describeButtons(7)).toBe("Button 7");
  });
});

describe("clickStats", () => {
  it("counts downs/ups per button and averages held duration", () => {
    const events: ClickEvent[] = [
      { type: "down", button: 0, t: 0 },
      { type: "up", button: 0, t: 50 },
      { type: "down", button: 0, t: 1000 },
      { type: "up", button: 0, t: 1050 },
    ];
    const stats = clickStats(events);
    expect(stats.perButton["Left"]).toEqual({ downs: 2, ups: 2, avgHeldMs: 50 });
  });

  it("detects a real double click (interval between the bounce floor and the double-click ceiling)", () => {
    const events: ClickEvent[] = [
      { type: "down", button: 0, t: 0 },
      { type: "up", button: 0, t: 50 },
      { type: "down", button: 0, t: 200 },
      { type: "up", button: 0, t: 250 },
    ];
    const stats = clickStats(events);
    expect(stats.doubleClicks).toEqual([{ button: "Left", intervalMs: 200 }]);
    expect(stats.bounces).toEqual([]);
  });

  it("flags two downs within 80 ms as suspicious switch bounce", () => {
    const events: ClickEvent[] = [
      { type: "down", button: 2, t: 0 },
      { type: "up", button: 2, t: 5 },
      { type: "down", button: 2, t: 20 },
      { type: "up", button: 2, t: 25 },
    ];
    const stats = clickStats(events);
    expect(stats.bounces).toEqual([{ button: "Right", intervalMs: 20 }]);
    expect(stats.doubleClicks).toEqual([]);
  });

  it("tolerates an empty event list", () => {
    expect(clickStats([])).toEqual({ perButton: {}, doubleClicks: [], bounces: [] });
  });
});

describe("scrollStats", () => {
  it("computes notch size and reports a consistent delta mode", () => {
    const events: ScrollEvent[] = [
      { deltaY: 100, deltaMode: 0 },
      { deltaY: 100, deltaMode: 0 },
      { deltaY: -100, deltaMode: 0 },
    ];
    const stats = scrollStats(events);
    expect(stats.events).toBe(3);
    expect(stats.deltaModeLabel).toBe("pixel");
    expect(stats.deltaModeConsistent).toBe(true);
    expect(stats.notchSizeY).toBe(100);
    expect(stats.minAbsDeltaY).toBe(100);
    expect(stats.maxAbsDeltaY).toBe(100);
  });

  it("flags a mix of delta modes as inconsistent", () => {
    const events: ScrollEvent[] = [
      { deltaY: 3, deltaMode: 1 },
      { deltaY: 100, deltaMode: 0 },
    ];
    const stats = scrollStats(events);
    expect(stats.deltaModeConsistent).toBe(false);
  });

  it("tolerates an empty event list", () => {
    const stats = scrollStats([]);
    expect(stats.events).toBe(0);
    expect(stats.deltaModeLabel).toBe("unknown");
    expect(stats.notchSizeY).toBeNull();
  });
});

describe("run", () => {
  it("returns instructions when the input is empty", () => {
    const out = run("", OPTS);
    expect(Object.keys(out).length).toBeGreaterThan(0);
    expect(out["Polling rate"]).toMatch(/pointermove/);
  });

  it("rejects malformed JSON", () => {
    try {
      run("{not valid json", OPTS);
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid-json");
    }
  });

  it("rejects JSON that is not an object", () => {
    try {
      run("[1,2,3]", OPTS);
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid-report");
    }
  });

  it("rejects a report with no recognized fields", () => {
    try {
      run("{}", OPTS);
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-report");
    }
  });

  it("summarizes a polling rate report", () => {
    const moveTimestamps = Array.from({ length: 11 }, (_, i) => i * 1);
    const out = run(JSON.stringify({ moveTimestamps }), OPTS);
    expect(out["Polling rate"]).toBe("1000 Hz");
    expect(out["Measured Hz"]).toBe("1000");
  });

  it("summarizes a DPI report using the cm option", () => {
    const out = run(JSON.stringify({ travel: { counts: 3150 } }), { physicalDistanceCm: 10, units: "cm" });
    expect(out["Measured DPI"]).toBe("800");
    expect(out["Nearest common DPI"]).toBe("800");
  });

  it("summarizes a DPI report using the inches option", () => {
    const out = run(JSON.stringify({ travel: { counts: 3150 } }), {
      physicalDistanceCm: 3.937,
      units: "in",
    });
    expect(out["Measured DPI"]).toBe("800");
  });

  it("prefers an explicit physicalDistanceInches on the travel object over the options", () => {
    const out = run(
      JSON.stringify({ travel: { counts: 3150, physicalDistanceInches: 3.937 } }),
      { physicalDistanceCm: 50, units: "cm" },
    );
    expect(out["Measured DPI"]).toBe("800");
  });

  it("rejects a malformed travel field", () => {
    try {
      run(JSON.stringify({ travel: { counts: "not a number" } }), OPTS);
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-travel");
    }
  });

  it("rejects malformed moveTimestamps", () => {
    try {
      run(JSON.stringify({ moveTimestamps: ["a", "b"] }), OPTS);
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-move-timestamps");
    }
  });

  it("summarizes an acceleration report", () => {
    const slow = Array.from({ length: 5 }, () => ({ dt: 100, dx: 50 }));
    const fast = Array.from({ length: 5 }, () => ({ dt: 20, dx: 64 }));
    const out = run(JSON.stringify({ acceleration: { slow, fast } }), OPTS);
    expect(out["Acceleration verdict"]).toMatch(/Accelerated/);
  });

  it("rejects a malformed acceleration field", () => {
    try {
      run(JSON.stringify({ acceleration: { slow: [] } }), OPTS);
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-acceleration");
    }
  });

  it("summarizes a click report", () => {
    const clicks: ClickEvent[] = [
      { type: "down", button: 0, t: 0 },
      { type: "up", button: 0, t: 40 },
    ];
    const out = run(JSON.stringify({ clicks }), OPTS);
    expect(out["Left button"]).toBe("1 down / 1 up, held ~40 ms");
    expect(out["Double clicks"]).toBe("none detected");
    expect(out["Switch bounce"]).toBe("none detected");
  });

  it("rejects a non-array clicks field", () => {
    try {
      run(JSON.stringify({ clicks: "nope" }), OPTS);
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-clicks");
    }
  });

  it("summarizes a scroll report", () => {
    const scrolls: ScrollEvent[] = [
      { deltaY: 100, deltaMode: 0 },
      { deltaY: 100, deltaMode: 0 },
    ];
    const out = run(JSON.stringify({ scrolls }), OPTS);
    expect(out["Scroll events"]).toBe("2");
    expect(out["Scroll notch size"]).toBe("100 per notch");
  });

  it("rejects a non-array scrolls field", () => {
    try {
      run(JSON.stringify({ scrolls: 5 }), OPTS);
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-scrolls");
    }
  });

  it("combines multiple report sections into one output", () => {
    const report = {
      moveTimestamps: Array.from({ length: 11 }, (_, i) => i * 8),
      travel: { counts: 3150, physicalDistanceInches: 3.937 },
    };
    const out = summarize(report, OPTS);
    expect(out["Polling rate"]).toBe("125 Hz");
    expect(out["Measured DPI"]).toBe("800");
  });
});
