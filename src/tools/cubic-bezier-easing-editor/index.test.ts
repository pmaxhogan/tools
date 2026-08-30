import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  EASING_PRESETS,
  bezierPoint,
  curveExtent,
  easingAt,
  formatCubicBezier,
  linearApproximation,
  nearestPreset,
  parseCubicBezier,
  presetControls,
  run,
  sampleCurve,
  trimNumber,
  validateControls,
} from "./index";

const LINEAR = { x1: 0, y1: 0, x2: 1, y2: 1 };
const EASE = { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 };
const SPRING = { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 };

describe("bezierPoint", () => {
  it("pins both ends of the curve", () => {
    expect(bezierPoint(EASE, 0)).toEqual({ x: 0, y: 0 });
    const end = bezierPoint(EASE, 1);
    expect(end.x).toBeCloseTo(1, 10);
    expect(end.y).toBeCloseTo(1, 10);
  });

  it("clamps a parameter outside 0 to 1", () => {
    expect(bezierPoint(EASE, -5)).toEqual({ x: 0, y: 0 });
    expect(bezierPoint(EASE, 5).x).toBeCloseTo(1, 10);
  });
});

describe("easingAt", () => {
  it("is the identity for the linear keyword", () => {
    for (const x of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
      expect(easingAt(LINEAR, x)).toBeCloseTo(x, 6);
    }
  });

  it("runs ahead of linear in the first half of ease", () => {
    expect(easingAt(EASE, 0.25)).toBeGreaterThan(0.25);
    expect(easingAt(EASE, 0.5)).toBeGreaterThan(0.5);
  });

  it("stays pinned at the ends and rises monotonically for ease-in-out", () => {
    const c = presetControls("ease-in-out");
    expect(easingAt(c, 0)).toBe(0);
    expect(easingAt(c, 1)).toBe(1);
    let previous = -1;
    for (let i = 0; i <= 20; i += 1) {
      const value = easingAt(c, i / 20);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });

  it("passes 1 before the end on an overshooting curve", () => {
    expect(easingAt(SPRING, 0.6)).toBeGreaterThan(1);
    expect(easingAt(SPRING, 1)).toBe(1);
  });
});

describe("sampleCurve and curveExtent", () => {
  it("returns one more point than the step count", () => {
    expect(sampleCurve(EASE, 8)).toHaveLength(9);
  });

  it("reports the overshoot of a spring and the plain range of an ease", () => {
    expect(curveExtent(EASE)).toEqual({ min: 0, max: 1 });
    const spring = curveExtent(SPRING);
    expect(spring.max).toBeGreaterThan(1);
    expect(spring.min).toBe(0);
    const anticipate = curveExtent(presetControls("anticipate"));
    expect(anticipate.min).toBeLessThan(0);
    expect(anticipate.max).toBeGreaterThan(1);
  });
});

describe("parseCubicBezier", () => {
  it("reads the CSS keywords into their real control points", () => {
    expect(parseCubicBezier("ease")).toEqual(EASE);
    expect(parseCubicBezier("linear")).toEqual(LINEAR);
    expect(parseCubicBezier("ease-in-out")).toEqual({ x1: 0.42, y1: 0, x2: 0.58, y2: 1 });
  });

  it("reads a function, with or without the property name", () => {
    expect(parseCubicBezier("cubic-bezier(.25,.1,.25,1)")).toEqual(EASE);
    expect(parseCubicBezier("transition-timing-function: cubic-bezier(0, 0, 1, 1);")).toEqual(
      LINEAR,
    );
  });

  it("reads four bare numbers", () => {
    expect(parseCubicBezier("0.34, 1.56, 0.64, 1")).toEqual(SPRING);
  });

  it("rejects an empty value", () => {
    try {
      parseCubicBezier("");
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("explains that a step easing has no curve", () => {
    for (const text of ["steps(4, end)", "step-start"]) {
      try {
        parseCubicBezier(text);
        throw new Error("expected a ToolError");
      } catch (e) {
        expect(e).toBeInstanceOf(ToolError);
        expect((e as ToolError).code).toBe("not-a-bezier");
      }
    }
  });

  it("rejects the wrong number of values and a non-number", () => {
    for (const text of ["cubic-bezier(0, 0, 1)", "cubic-bezier(0, 0, 1, fast)"]) {
      try {
        parseCubicBezier(text);
        throw new Error("expected a ToolError");
      } catch (e) {
        expect(e).toBeInstanceOf(ToolError);
        expect((e as ToolError).code).toBe("bad-bezier");
      }
    }
  });

  it("rejects an x value outside 0 to 1, and says why", () => {
    try {
      parseCubicBezier("cubic-bezier(-0.5, 0, 1, 1)");
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("out-of-range");
      expect((e as ToolError).fix).toContain("time");
    }
  });

  it("allows a y value well outside 0 to 1", () => {
    expect(() => parseCubicBezier("cubic-bezier(0.68, -0.55, 0.27, 1.55)")).not.toThrow();
  });
});

describe("validateControls", () => {
  it("returns a copy rather than the original object", () => {
    const input = { ...EASE };
    const out = validateControls(input);
    out.x1 = 0.9;
    expect(input.x1).toBe(0.25);
  });

  it("rejects a non-finite y", () => {
    try {
      validateControls({ x1: 0, y1: Number.NaN, x2: 1, y2: 1 });
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-bezier");
    }
  });
});

describe("formatCubicBezier", () => {
  it("trims the numbers without losing precision that matters", () => {
    expect(formatCubicBezier(EASE)).toBe("cubic-bezier(0.25, 0.1, 0.25, 1)");
    expect(formatCubicBezier(SPRING)).toBe("cubic-bezier(0.34, 1.56, 0.64, 1)");
  });
});

describe("linearApproximation", () => {
  it("writes a bare value at each end and a percentage in between", () => {
    const value = linearApproximation(LINEAR, 4);
    expect(value.startsWith("linear(0, ")).toBe(true);
    expect(value.endsWith(", 1)")).toBe(true);
    expect(value.split(",")).toHaveLength(5);
    expect(value).toContain("%");
  });

  it("tracks the curve it approximates", () => {
    const value = linearApproximation(EASE, 20);
    const entries = value
      .slice("linear(".length, -1)
      .split(",")
      .map((part) => part.trim().split(/\s+/));
    for (const entry of entries) {
      if (entry.length !== 2) continue;
      const y = Number(entry[0]);
      const x = Number(entry[1].replace("%", "")) / 100;
      expect(y).toBeCloseTo(easingAt(EASE, x), 3);
    }
  });

  it("rejects a stop count outside the sane range", () => {
    for (const steps of [1, 500]) {
      try {
        linearApproximation(EASE, steps);
        throw new Error("expected a ToolError");
      } catch (e) {
        expect(e).toBeInstanceOf(ToolError);
        expect((e as ToolError).code).toBe("bad-option");
      }
    }
  });
});

describe("nearestPreset", () => {
  it("recognizes every preset as itself", () => {
    for (const preset of EASING_PRESETS) {
      const match = nearestPreset(preset.controls);
      expect(match.preset.value).toBe(preset.value);
      expect(match.exact).toBe(true);
      expect(match.distance).toBeCloseTo(0, 10);
    }
  });

  it("names the closest curve for something between two presets", () => {
    const match = nearestPreset({ x1: 0.02, y1: 0.01, x2: 0.56, y2: 0.99 });
    expect(match.preset.value).toBe("ease-out");
    expect(match.exact).toBe(false);
    expect(match.distance).toBeLessThan(0.05);
  });
});

describe("presetControls", () => {
  it("rejects a preset it does not carry", () => {
    try {
      presetControls("bouncy");
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("unknown-preset");
    }
  });
});

describe("run", () => {
  it("emits the value, the declarations, and the closest preset", () => {
    const out = run("", { preset: "ease" });
    expect(out.startsWith("cubic-bezier(0.25, 0.1, 0.25, 1)")).toBe(true);
    expect(out).toContain("transition-timing-function: cubic-bezier(0.25, 0.1, 0.25, 1);");
    expect(out).toContain("transition: all 400ms cubic-bezier(0.25, 0.1, 0.25, 1);");
    expect(out).toContain("exactly the ease curve");
    expect(out).toContain("linear(");
  });

  it("parses an input value and honors the duration", () => {
    const out = run("cubic-bezier(0, 0, 1, 1)", { duration: 120, linearApproximation: false });
    expect(out).toContain("transition: all 120ms cubic-bezier(0, 0, 1, 1);");
    expect(out).not.toContain("linear(");
  });

  it("warns when the curve overshoots", () => {
    const out = run("cubic-bezier(0.34, 1.56, 0.64, 1)", {});
    expect(out).toContain("leaves the 0 to 1 range");
    expect(out).toContain("transform");
  });

  it("says nothing about overshoot for a curve that stays inside", () => {
    expect(run("", { preset: "ease-in-out" })).not.toContain("leaves the 0 to 1 range");
  });

  it("rejects bad options", () => {
    expect(() => run("", { duration: 0 })).toThrowError(ToolError);
    expect(() => run("", { stops: 1 })).toThrowError(ToolError);
    expect(() => run("", { preset: "wobble" })).toThrowError(ToolError);
  });

  it("keeps trimNumber tidy", () => {
    expect(trimNumber(1, 4)).toBe("1");
    expect(trimNumber(0.10000001, 4)).toBe("0.1");
  });
});
