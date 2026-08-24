import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  describeLux,
  estimateCct,
  estimateLux,
  evFromLux,
  linearLuma,
  rollingAverage,
  run,
  sRGBToLinear,
} from "./index";

/** The ToolError code thrown by fn, or "no-error" when it does not throw. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ToolError);
    return (e as ToolError).code;
  }
  return "no-error";
}

describe("estimateLux", () => {
  it("uses the measured incident-light formula when exposure settings are given", () => {
    // ISO 100, f/2, 1/250s: EV100 = log2(N^2/t) - log2(ISO/100) = log2(1000) ~ 9.97.
    const result = estimateLux({
      meanLuma: 0.18,
      exposureTimeSec: 1 / 250,
      iso: 100,
      fNumber: 2,
    });
    expect(result.confidence).toBe("measured");
    expect(result.ev).toBeCloseTo(Math.log2(1000), 3);
    // meanLuma sits exactly on 18% gray, so the scale factor is 1 and lux equals
    // the nominal 2.5 * 2^EV value.
    expect(result.lux).toBeCloseTo(2500, 2);
    expect(result.range[0]).toBeLessThan(result.lux);
    expect(result.range[1]).toBeGreaterThan(result.lux);
  });

  it("scales the measured lux up or down when mean luma is off 18% gray", () => {
    const brighter = estimateLux({
      meanLuma: 0.36,
      exposureTimeSec: 1 / 250,
      iso: 100,
      fNumber: 2,
    });
    // Twice the luma of 18% gray should roughly double the estimate.
    expect(brighter.lux).toBeCloseTo(5000, 2);
  });

  it("falls back to a rough brightness-only estimate without exposure data", () => {
    const result = estimateLux({ meanLuma: 0.36 });
    expect(result.confidence).toBe("rough");
    // 300 * (0.36/0.18)^2.5 = 300 * 2^2.5
    expect(result.lux).toBeCloseTo(300 * 2 ** 2.5, 2);
    expect(result.range).toEqual([result.lux * 0.5, result.lux * 1.5]);
  });

  it("applies the calibration factor linearly on the rough path", () => {
    const base = estimateLux({ meanLuma: 0.36 });
    const calibrated = estimateLux({ meanLuma: 0.36, calibration: 2 });
    expect(calibrated.lux).toBeCloseTo(base.lux * 2, 6);
  });

  it("never returns a non-finite lux for a black frame", () => {
    const result = estimateLux({ meanLuma: 0 });
    expect(Number.isFinite(result.lux)).toBe(true);
    expect(result.lux).toBeGreaterThan(0);
  });
});

describe("evFromLux", () => {
  it("inverts the lux formula used by estimateLux", () => {
    expect(evFromLux(2500)).toBeCloseTo(Math.log2(1000), 6);
  });

  it("stays finite for zero or negative lux", () => {
    expect(Number.isFinite(evFromLux(0))).toBe(true);
    expect(Number.isFinite(evFromLux(-5))).toBe(true);
  });
});

describe("describeLux", () => {
  it.each([
    [0.5, "moonlight"],
    [30, "a dim room"],
    [150, "typical living room lighting"],
    [400, "office lighting"],
    [1500, "an overcast day"],
    [15000, "full daylight"],
    [75000, "direct sunlight"],
  ])("labels %d lux as %s", (lux, label) => {
    expect(describeLux(lux)).toBe(label);
  });

  it("labels a gap between two bands as between them", () => {
    expect(describeLux(5)).toBe("between moonlight and a dim room");
  });

  it("labels below the darkest band", () => {
    expect(describeLux(0.01)).toBe("darker than moonlight");
  });

  it("labels above the brightest band", () => {
    expect(describeLux(500000)).toBe("brighter than direct sunlight");
  });
});

describe("estimateCct", () => {
  it("reads a linear-light white point as roughly D65 (~6500 K, overcast)", () => {
    const result = estimateCct({ r: 1, g: 1, b: 1 });
    expect(Math.abs(result.cct - 6500)).toBeLessThan(150);
    expect(result.label).toBe("overcast");
    expect(result.note.length).toBeGreaterThan(0);
  });

  it("reads a red-heavy color as warm, in the incandescent region", () => {
    const result = estimateCct({ r: 1, g: 0.4, b: 0.1 });
    expect(result.cct).toBeGreaterThan(2000);
    expect(result.cct).toBeLessThan(3200);
    expect(result.label).toBe("incandescent");
  });

  it("clamps to the documented 1000..25000 K range", () => {
    const veryBlue = estimateCct({ r: 0.01, g: 0.1, b: 1 });
    expect(veryBlue.cct).toBeGreaterThanOrEqual(1000);
    expect(veryBlue.cct).toBeLessThanOrEqual(25000);
  });

  it("does not throw on a fully black frame", () => {
    const result = estimateCct({ r: 0, g: 0, b: 0 });
    expect(Number.isFinite(result.cct)).toBe(true);
  });
});

describe("sRGBToLinear / linearLuma", () => {
  it("maps the endpoints of the sRGB curve", () => {
    expect(sRGBToLinear(0)).toBe(0);
    expect(sRGBToLinear(1)).toBeCloseTo(1, 6);
  });

  it("matches the known sRGB midpoint conversion", () => {
    expect(sRGBToLinear(0.5)).toBeCloseTo(0.214, 2);
  });

  it("computes Rec. 709 luma from linear channels", () => {
    expect(linearLuma(1, 1, 1)).toBeCloseTo(1, 6);
    expect(linearLuma(1, 0, 0)).toBeCloseTo(0.2126, 6);
    expect(linearLuma(0, 0, 0)).toBe(0);
  });
});

describe("rollingAverage", () => {
  it("averages the last n samples", () => {
    expect(rollingAverage([1, 2, 3, 4, 5], 3)).toBeCloseTo(4, 6);
  });

  it("uses whatever is available when fewer than n samples exist", () => {
    expect(rollingAverage([1, 2], 5)).toBeCloseTo(1.5, 6);
  });

  it("returns 0 for an empty series", () => {
    expect(rollingAverage([], 4)).toBe(0);
  });
});

describe("run", () => {
  it("explains the panel when given empty input", () => {
    const result = run("", {});
    expect(result.Status).toBeDefined();
    expect(result.Status).toContain("Point the camera");
  });

  it("explains the panel for whitespace-only input", () => {
    const result = run("   ", {});
    expect(result.Status).toContain("Point the camera");
  });

  it("reports a full measured frame", () => {
    const report = JSON.stringify({
      meanLuma: 0.18,
      r: 1,
      g: 1,
      b: 1,
      exposureTimeSec: 1 / 250,
      iso: 100,
      fNumber: 2,
    });
    const result = run(report, {});
    expect(result["Illuminance estimate"]).toContain("measured from exposure settings");
    expect(result["Camera exposure settings used"]).toContain("f/2");
    expect(result["Camera exposure settings used"]).toContain("ISO 100");
    expect(result["Color temperature estimate"]).toContain("K");
    expect(result["Color temperature estimate"]).toContain("overcast");
    expect(result["Color temperature note"]).toBeDefined();
    expect(result["EV100"]).toBeDefined();
    expect(result["Light level"]).toBeDefined();
  });

  it("falls back to a rough estimate without exposure data", () => {
    const report = JSON.stringify({ meanLuma: 0.5, r: 0.9, g: 0.9, b: 0.9 });
    const result = run(report, {});
    expect(result["Illuminance estimate"]).toContain("rough estimate from brightness only");
    expect(result["Camera exposure settings used"]).toContain("Not exposed by this browser");
  });

  it("marks color temperature unavailable when the report has no color channels", () => {
    const report = JSON.stringify({ meanLuma: 0.2 });
    const result = run(report, {});
    expect(result["Color temperature estimate"]).toBe(
      "Not available: the frame report did not include color channel data.",
    );
    expect(result["Color temperature note"]).toBeUndefined();
  });

  it("converts to footcandles when requested", () => {
    const report = JSON.stringify({ meanLuma: 0.5 });
    const result = run(report, { units: "footcandles" });
    expect(result["Illuminance estimate"]).toContain("fc");
  });

  it("throws bad-json for invalid JSON", () => {
    expect(codeOf(() => run("not json", {}))).toBe("bad-json");
  });

  it("throws not-a-report for a non-object JSON value", () => {
    expect(codeOf(() => run("[]", {}))).toBe("not-a-report");
  });

  it("throws not-a-report when meanLuma is missing", () => {
    expect(codeOf(() => run(JSON.stringify({ foo: 1 }), {}))).toBe("not-a-report");
  });

  it("throws bad-option for an out-of-range calibration", () => {
    const report = JSON.stringify({ meanLuma: 0.5 });
    expect(codeOf(() => run(report, { calibration: 50 }))).toBe("bad-option");
  });

  it("throws bad-option for unknown units", () => {
    const report = JSON.stringify({ meanLuma: 0.5 });
    expect(codeOf(() => run(report, { units: "banana" }))).toBe("bad-option");
  });
});
