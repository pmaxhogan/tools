import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  buildClamp,
  buildScale,
  formatLength,
  normalizePrefix,
  parseShorthand,
  run,
  sizeAt,
  trimNumber,
  zoomNote,
} from "./index";

describe("trimNumber", () => {
  it("drops trailing zeros but keeps whole numbers intact", () => {
    expect(trimNumber(1.5, 4)).toBe("1.5");
    expect(trimNumber(100, 4)).toBe("100");
    expect(trimNumber(0.833333, 4)).toBe("0.8333");
  });

  it("never reports a negative zero", () => {
    expect(trimNumber(-0.00001, 3)).toBe("0");
  });
});

describe("formatLength", () => {
  it("converts px to rem against the root size", () => {
    expect(formatLength(24, "rem", 16)).toBe("1.5rem");
    expect(formatLength(24, "px", 16)).toBe("24px");
  });

  it("honors a non-default root size", () => {
    expect(formatLength(20, "rem", 10)).toBe("2rem");
  });
});

describe("buildClamp", () => {
  it("computes the slope and intercept of the classic 16 to 24 ramp", () => {
    const result = buildClamp(
      { minSize: 16, maxSize: 24, minViewport: 320, maxViewport: 1280 },
      "rem",
      16,
    );
    expect(result.slope).toBeCloseTo(0.008333, 6);
    expect(result.interceptPx).toBeCloseTo(13.3333, 3);
    expect(result.vw).toBeCloseTo(0.83333, 4);
    expect(result.expression).toBe("clamp(1rem, 0.8333rem + 0.8333vw, 1.5rem)");
    expect(result.descending).toBe(false);
  });

  it("orders the clamp arguments smallest first on a descending ramp", () => {
    const result = buildClamp(
      { minSize: 24, maxSize: 16, minViewport: 320, maxViewport: 1280 },
      "px",
      16,
    );
    expect(result.descending).toBe(true);
    expect(result.expression.startsWith("clamp(16px,")).toBe(true);
    expect(result.expression.endsWith("24px)")).toBe(true);
    expect(result.slope).toBeLessThan(0);
  });

  it("drops the rem term entirely when the intercept is exactly zero", () => {
    // A line through the origin: 10px at 500px wide, 20px at 1000px wide.
    const result = buildClamp(
      { minSize: 10, maxSize: 20, minViewport: 500, maxViewport: 1000 },
      "rem",
      16,
    );
    expect(result.interceptPx).toBe(0);
    expect(result.preferred).toBe("2vw");
  });

  it("rejects a max viewport that is not wider than the min", () => {
    expect(() =>
      buildClamp({ minSize: 16, maxSize: 24, minViewport: 1280, maxViewport: 320 }, "rem", 16),
    ).toThrowError(ToolError);
    try {
      buildClamp({ minSize: 16, maxSize: 24, minViewport: 800, maxViewport: 800 }, "rem", 16);
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-range");
    }
  });

  it("rejects a flat range that would not be fluid", () => {
    try {
      buildClamp({ minSize: 18, maxSize: 18, minViewport: 320, maxViewport: 1280 }, "rem", 16);
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("flat-range");
    }
  });
});

describe("sizeAt", () => {
  const result = buildClamp(
    { minSize: 16, maxSize: 24, minViewport: 320, maxViewport: 1280 },
    "rem",
    16,
  );

  it("clamps below the min viewport and above the max", () => {
    expect(sizeAt(result, 200)).toBeCloseTo(16, 6);
    expect(sizeAt(result, 1920)).toBeCloseTo(24, 6);
  });

  it("interpolates in between", () => {
    expect(sizeAt(result, 800)).toBeCloseTo(20, 6);
    expect(sizeAt(result, 768)).toBeCloseTo(19.7333, 3);
  });
});

describe("parseShorthand", () => {
  it("returns nothing for an empty line", () => {
    expect(parseShorthand("", 16)).toEqual({});
    expect(parseShorthand("   ", 16)).toEqual({});
  });

  it("reads four lengths with mixed units and separators", () => {
    expect(parseShorthand("1rem to 2rem at 320px, 1280px", 16)).toEqual({
      minSize: 16,
      maxSize: 32,
      minViewport: 320,
      maxViewport: 1280,
    });
  });

  it("reads two lengths as sizes only", () => {
    expect(parseShorthand("18px 32px", 16)).toEqual({ minSize: 18, maxSize: 32 });
  });

  it("rejects a token that is not a length", () => {
    try {
      parseShorthand("16px huge", 16);
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-shorthand");
    }
  });

  it("rejects the wrong number of lengths", () => {
    try {
      parseShorthand("16px 24px 320px", 16);
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-shorthand");
    }
  });
});

describe("normalizePrefix", () => {
  it("defaults to step and strips leading dashes", () => {
    expect(normalizePrefix("")).toBe("step");
    expect(normalizePrefix("--fs")).toBe("fs");
  });

  it("rejects a name that is not a CSS identifier", () => {
    try {
      normalizePrefix("1size");
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-prefix");
    }
  });
});

describe("buildScale", () => {
  it("names negative steps with a double dash and keeps the base at ratio one", () => {
    const steps = buildScale(
      { minSize: 16, maxSize: 20, minViewport: 320, maxViewport: 1280 },
      1.2,
      1.25,
      1,
      2,
      "step",
      "px",
      16,
    );
    expect(steps.map((s) => s.property)).toEqual(["--step--1", "--step-0", "--step-1", "--step-2"]);
    expect(steps[1].result.spec.minSize).toBeCloseTo(16, 6);
    expect(steps[2].result.spec.minSize).toBeCloseTo(19.2, 6);
    expect(steps[0].result.spec.maxSize).toBeCloseTo(16, 6);
  });
});

describe("zoomNote", () => {
  it("passes a positive intercept and warns on a negative one", () => {
    const good = buildClamp(
      { minSize: 16, maxSize: 24, minViewport: 320, maxViewport: 1280 },
      "rem",
      16,
    );
    expect(zoomNote(good)).toContain("positive rem term");

    const flat = buildClamp(
      { minSize: 16, maxSize: 64, minViewport: 320, maxViewport: 1280 },
      "rem",
      16,
    );
    expect(flat.interceptPx).toBe(0);
    expect(zoomNote(flat)).toContain("no rem term");

    const bad = buildClamp(
      { minSize: 16, maxSize: 80, minViewport: 320, maxViewport: 1280 },
      "rem",
      16,
    );
    expect(bad.interceptPx).toBeLessThan(0);
    expect(zoomNote(bad)).toContain("negative");
  });
});

describe("run", () => {
  it("produces the single-size record with a preview row per width", () => {
    const out = run("", {});
    expect(out["CSS value"]).toBe("clamp(1rem, 0.8333rem + 0.8333vw, 1.5rem)");
    expect(out["Custom property"]).toBe("--fluid-size: clamp(1rem, 0.8333rem + 0.8333vw, 1.5rem);");
    expect(out["At 320px viewport"]).toContain("1rem");
    expect(out["At 320px viewport"]).toContain("(clamped)");
    expect(out["At 768px viewport"]).toBe("1.2333rem (19.73px)");
    expect(out["At 1920px viewport"]).toContain("(clamped)");
    expect(out["Zoom check (WCAG 1.4.4)"]).toContain("WCAG 1.4.4");
  });

  it("lets the quick-entry line override the option values", () => {
    const out = run("20px 40px 400px 1200px", { unit: "px" });
    expect(out["CSS value"]).toBe("clamp(20px, 10px + 2.5vw, 40px)");
    expect(out["At 1440px viewport"]).toContain("40px");
  });

  it("builds a whole type scale with a custom property block", () => {
    const out = run("", { mode: "scale", stepsUp: 2, stepsDown: 1, prefix: "fs" });
    expect(out["CSS custom properties"]).toContain(":root {");
    expect(out["CSS custom properties"]).toContain("--fs--1:");
    expect(out["--fs-0"]).toBe("clamp(1rem, 0.8333rem + 0.8333vw, 1.5rem)");
    expect(out["--fs-2"]).toBeDefined();
    expect(out["Scale"]).toBe("1.2 at 320px, 1.25 at 1280px");
    expect(out["Base step at 768px viewport"]).toBeDefined();
  });

  it("reports the direction on a descending ramp", () => {
    const out = run("", { minSize: 32, maxSize: 20 });
    expect(out["Direction"]).toContain("shrinks as the viewport grows");
    // A negative slope has to be written as a subtraction: "+ -1.25vw" is not
    // valid CSS math.
    expect(out["CSS value"]).toBe("clamp(1.25rem, 2.25rem - 1.25vw, 2rem)");
  });

  it("rejects an out-of-range option", () => {
    try {
      run("", { rootSize: 0 });
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-option");
    }
  });

  it("rejects an unknown mode and an unknown unit", () => {
    expect(() => run("", { mode: "wobble" })).toThrowError(ToolError);
    expect(() => run("", { unit: "pt" })).toThrowError(ToolError);
  });

  it("rejects a ratio outside the sane range", () => {
    try {
      run("", { mode: "scale", minRatio: "9" });
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-option");
    }
  });
});
