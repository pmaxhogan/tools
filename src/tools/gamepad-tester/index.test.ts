import { describe, expect, it } from "vitest";
import {
  STANDARD_MAPPING,
  detectVendor,
  describeGamepad,
  describeButtons,
  triggerRange,
  analyzeDrift,
  circularityTest,
  summarizeSession,
  vibrationSupport,
  run,
} from "./index";

const XBOX_ID = "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 02fd)";
const DUALSENSE_ID = "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)";
const PRO_CONTROLLER_ID = "Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)";

describe("STANDARD_MAPPING", () => {
  it("has 17 buttons and 4 axes", () => {
    expect(STANDARD_MAPPING.buttons).toHaveLength(17);
    expect(STANDARD_MAPPING.axes).toHaveLength(4);
  });

  it("indexes buttons and axes contiguously from 0", () => {
    STANDARD_MAPPING.buttons.forEach((b, i) => expect(b.index).toBe(i));
    STANDARD_MAPPING.axes.forEach((a, i) => expect(a.index).toBe(i));
  });

  it("gives every button and axis a unique id", () => {
    expect(new Set(STANDARD_MAPPING.buttons.map((b) => b.id)).size).toBe(17);
    expect(new Set(STANDARD_MAPPING.axes.map((a) => a.id)).size).toBe(4);
  });
});

describe("detectVendor", () => {
  it("recognizes an Xbox controller id", () => {
    expect(detectVendor(XBOX_ID)).toBe("xbox");
  });

  it("recognizes a DualSense id", () => {
    expect(detectVendor(DUALSENSE_ID)).toBe("playstation");
  });

  it("recognizes a Switch Pro Controller id", () => {
    expect(detectVendor(PRO_CONTROLLER_ID)).toBe("switch");
  });

  it("falls back to generic for an unrecognized id", () => {
    expect(detectVendor("Some Unknown HID Device")).toBe("generic");
  });

  it("falls back to generic for empty/missing input", () => {
    expect(detectVendor("")).toBe("generic");
    expect(detectVendor(null)).toBe("generic");
    expect(detectVendor(undefined)).toBe("generic");
  });
});

describe("describeGamepad", () => {
  it("reports a standard-layout controller as recognized", () => {
    const rows = describeGamepad({ id: XBOX_ID, mapping: "standard", buttons: 17, axes: 4 });
    expect(rows["Detected type"]).toBe("Xbox controller");
    expect(rows["Standard layout"]).toBe("yes");
    expect(rows.Controller).toBe(XBOX_ID);
  });

  it("flags a nonstandard button/axis count", () => {
    const rows = describeGamepad({ id: "Weird Pad", mapping: "", buttons: 12, axes: 2 });
    expect(rows["Standard layout"]).toContain("no");
  });
});

describe("describeButtons", () => {
  it("labels pressed, touched, and released buttons for xbox", () => {
    const rows = describeButtons(
      [
        { index: 0, value: 1, pressed: true },
        { index: 6, value: 0.5, pressed: false, touched: true },
        { index: 3, value: 0, pressed: false },
      ],
      "xbox",
    );
    expect(rows.A).toBe("pressed (1.00)");
    expect(rows.LT).toBe("touched, not pressed");
    expect(rows.Y).toBe("released");
  });

  it("ignores malformed entries without throwing", () => {
    const rows = describeButtons([{ pressed: true } as unknown as { index: number; value: number; pressed: boolean }]);
    expect(Object.keys(rows)).toHaveLength(0);
  });
});

describe("triggerRange", () => {
  it("detects a trigger that reaches both ends of travel", () => {
    const r = triggerRange([0, 0.3, 0.6, 1]);
    expect(r.reachesZero).toBe(true);
    expect(r.reachesFull).toBe(true);
    expect(r.range).toBeCloseTo(1, 5);
  });

  it("detects a trigger that never reaches full", () => {
    const r = triggerRange([0, 0.1, 0.4, 0.7]);
    expect(r.reachesZero).toBe(true);
    expect(r.reachesFull).toBe(false);
  });

  it("returns zeros for an empty series", () => {
    expect(triggerRange([])).toEqual({ min: 0, max: 0, range: 0, reachesZero: false, reachesFull: false });
  });
});

describe("analyzeDrift", () => {
  it("reports no drift for perfectly centered resting samples", () => {
    const samples = Array.from({ length: 30 }, (_, i) => ({ t: i * 16, x: 0, y: 0 }));
    const result = analyzeDrift(samples);
    expect(result.verdict).toBe("no drift");
    expect(result.magnitude).toBeCloseTo(0, 10);
    expect(result.stdDev).toBeCloseTo(0, 10);
  });

  it("reports drift for a stick resting off-center, with a suggested deadzone that covers it", () => {
    const samples = Array.from({ length: 30 }, (_, i) => ({ t: i * 16, x: 0.08, y: 0.02 }));
    const result = analyzeDrift(samples);
    expect(["minor drift", "noticeable drift"]).toContain(result.verdict);
    expect(result.suggestedDeadzone).toBeGreaterThanOrEqual(0.09);
  });

  it("has nonzero standard deviation for noisy samples", () => {
    const samples = [
      { t: 0, x: 0.01, y: 0.02 },
      { t: 1, x: -0.02, y: 0.01 },
      { t: 2, x: 0.03, y: -0.01 },
      { t: 3, x: -0.01, y: -0.02 },
      { t: 4, x: 0.02, y: 0.03 },
    ];
    const result = analyzeDrift(samples);
    expect(result.stdDev).toBeGreaterThan(0);
  });

  it("honors a custom deadzone when computing percentOutsideDeadzone", () => {
    const samples = [
      { t: 0, x: 0.1, y: 0 },
      { t: 1, x: 0.01, y: 0 },
    ];
    const result = analyzeDrift(samples, { deadzone: 0.05 });
    expect(result.percentOutsideDeadzone).toBeCloseTo(50, 5);
  });

  it("returns a zeroed, no-drift result for an empty sample set", () => {
    const result = analyzeDrift([]);
    expect(result.verdict).toBe("no drift");
    expect(result.magnitude).toBe(0);
  });
});

describe("circularityTest", () => {
  it("reports near-zero error for a perfect circle", () => {
    const samples = Array.from({ length: 36 }, (_, i) => {
      const theta = (i / 36) * 2 * Math.PI;
      return { t: i, x: Math.cos(theta), y: Math.sin(theta) };
    });
    const result = circularityTest(samples);
    expect(result.errorPercent).toBeCloseTo(0, 5);
    expect(result.minRadius).toBeCloseTo(1, 5);
    expect(result.maxRadius).toBeCloseTo(1, 5);
  });

  it("reports substantial error for an ellipse", () => {
    const samples = Array.from({ length: 36 }, (_, i) => {
      const theta = (i / 36) * 2 * Math.PI;
      return { t: i, x: Math.cos(theta), y: 0.5 * Math.sin(theta) };
    });
    const result = circularityTest(samples);
    expect(result.errorPercent).toBeGreaterThan(20);
  });

  it("returns zeros for an empty sample set", () => {
    expect(circularityTest([])).toEqual({ minRadius: 0, maxRadius: 0, meanRadius: 0, errorPercent: 0 });
  });
});

describe("summarizeSession", () => {
  it("counts presses, distinct buttons, and session length", () => {
    const rows = summarizeSession([
      { type: "connect", t: 0 },
      { type: "buttondown", index: 0, t: 100 },
      { type: "buttonup", index: 0, t: 150 },
      { type: "buttondown", index: 0, t: 200 },
      { type: "buttondown", index: 1, t: 250 },
      { type: "disconnect", t: 500 },
    ]);
    expect(rows["Total presses"]).toBe("3");
    expect(rows["Distinct buttons pressed"]).toBe("2");
    expect(rows["Connect events"]).toBe("1");
    expect(rows["Disconnect events"]).toBe("1");
    expect(rows["Session length"]).toBe("500ms");
  });

  it("handles an empty event log", () => {
    const rows = summarizeSession([]);
    expect(rows["Total presses"]).toBe("0");
  });
});

describe("vibrationSupport", () => {
  it("reports a vibrationActuator type when present", () => {
    expect(vibrationSupport({ vibrationActuator: { type: "dual-rumble" } })).toBe("Supported (dual-rumble)");
  });

  it("reports haptic actuator count when present", () => {
    expect(vibrationSupport({ hapticActuators: [{}, {}] })).toBe("Supported (2 haptic actuators)");
  });

  it("reports unsupported when neither is present", () => {
    expect(vibrationSupport({})).toBe("Not supported by this browser or controller");
  });
});

describe("run", () => {
  it("explains how to connect a controller for empty input", () => {
    const result = run("", {});
    expect(result.Status).toMatch(/no controller/i);
    expect(result.Instructions).toMatch(/press any button/i);
  });

  it("describes a full report with buttons, drift, and circularity", () => {
    const input = JSON.stringify({
      gamepad: {
        id: XBOX_ID,
        mapping: "standard",
        buttons: 17,
        axes: 4,
        pressed: [{ index: 0, value: 1, pressed: true }],
        vibrationActuator: { type: "dual-rumble" },
      },
      driftSamples: [
        { t: 0, x: 0.01, y: 0.01 },
        { t: 16, x: 0.01, y: 0.01 },
      ],
      circularity: [
        { t: 0, x: 1, y: 0 },
        { t: 1, x: 0, y: 1 },
        { t: 2, x: -1, y: 0 },
        { t: 3, x: 0, y: -1 },
      ],
      buttonEvents: [
        { type: "buttondown", index: 0, t: 0 },
        { type: "buttonup", index: 0, t: 100 },
      ],
    });
    const result = run(input, { deadzone: 0.05, labels: "auto" });
    expect(result["Detected type"]).toBe("Xbox controller");
    expect(result["Button A"]).toBe("pressed (1.00)");
    expect(result.Vibration).toBe("Supported (dual-rumble)");
    expect(result["Drift: verdict"]).toBeDefined();
    expect(result["Circularity: error"]).toBeDefined();
    expect(result["Session: Total presses"]).toBe("1");
  });

  it("respects a forced label set instead of auto-detection", () => {
    const input = JSON.stringify({
      gamepad: { id: XBOX_ID, mapping: "standard", buttons: 17, axes: 4, pressed: [{ index: 0, value: 1, pressed: true }] },
    });
    const result = run(input, { labels: "playstation" });
    expect(result["Button Cross"]).toBe("pressed (1.00)");
  });

  it("throws a bad-json error for unparsable input", () => {
    expect(() => run("{not json", {})).toThrow(/could not parse/i);
  });

  it("throws a not-a-report error when the gamepad field is missing", () => {
    expect(() => run(JSON.stringify({ foo: "bar" }), {})).toThrow(/gamepad field/i);
  });

  it("throws a not-a-report error when the gamepad object is incomplete", () => {
    expect(() => run(JSON.stringify({ gamepad: { id: "x" } }), {})).toThrow(/missing/i);
  });
});
