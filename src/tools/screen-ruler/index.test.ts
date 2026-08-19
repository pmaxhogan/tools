import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  aspectRatio,
  angle,
  calibrate,
  contrastRatio,
  describeDisplay,
  distance,
  formatMeasurement,
  nearestCssColorName,
  pxToUnits,
  rectFromPoints,
  rgbaToHex,
  run,
  unitsToPx,
} from "./index";

describe("pxToUnits", () => {
  it("converts 96 px to 1 inch / 25.4 mm at 96 CSS ppi", () => {
    const m = pxToUnits(96, {});
    expect(m.px).toBe(96);
    expect(m.cssPx).toBe(96);
    expect(m.inches).toBeCloseTo(1, 10);
    expect(m.mm).toBeCloseTo(25.4, 10);
    expect(m.cm).toBeCloseTo(2.54, 10);
    expect(m.points).toBeCloseTo(72, 10);
  });

  it("doubles devicePx at dpr 2 without changing real-world units", () => {
    const m = pxToUnits(96, { dpr: 2 });
    expect(m.devicePx).toBe(192);
    expect(m.mm).toBeCloseTo(25.4, 10);
  });

  it("defaults dpr to 1 when omitted", () => {
    const m = pxToUnits(50, {});
    expect(m.devicePx).toBe(50);
  });

  it("uses calibrationPxPerMm over the CSS ppi default when given", () => {
    const m = pxToUnits(200, { calibrationPxPerMm: 2 });
    expect(m.mm).toBeCloseTo(100, 10);
  });
});

describe("unitsToPx", () => {
  it("is the inverse of pxToUnits for mm at the default ppi", () => {
    const px = unitsToPx(25.4, "mm", {});
    expect(px).toBeCloseTo(96, 8);
  });

  it("passes px through unchanged", () => {
    expect(unitsToPx(42, "px", {})).toBe(42);
  });

  it("round-trips through calibration", () => {
    const ppmm = calibrate(85.6, 200);
    const px = unitsToPx(85.6, "mm", { calibrationPxPerMm: ppmm });
    expect(px).toBeCloseTo(200, 6);
  });
});

describe("calibrate", () => {
  it("computes pixels per millimetre from a known length", () => {
    expect(calibrate(85.6, 200)).toBeCloseTo(2.336448598, 6);
  });

  it("round-trips into pxToUnits", () => {
    const ppmm = calibrate(85.6, 200);
    const m = pxToUnits(200, { calibrationPxPerMm: ppmm });
    expect(m.mm).toBeCloseTo(85.6, 6);
  });

  it("throws a ToolError for a non-positive known length", () => {
    expect(() => calibrate(0, 200)).toThrowError(ToolError);
    expect(() => calibrate(-5, 200)).toThrowError(ToolError);
  });

  it("throws a ToolError for a non-positive measured pixel distance", () => {
    expect(() => calibrate(85.6, 0)).toThrowError(ToolError);
  });
});

describe("distance and angle", () => {
  it("measures a 3-4-5 triangle as distance 5", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it("measures a 45 degree angle for equal dx and dy", () => {
    expect(angle({ x: 0, y: 0 }, { x: 10, y: 10 })).toBeCloseTo(45, 10);
  });

  it("measures 0 degrees pointing along positive x", () => {
    expect(angle({ x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(0, 10);
  });

  it("measures -90 degrees pointing up (negative y)", () => {
    expect(angle({ x: 0, y: 0 }, { x: 0, y: -10 })).toBeCloseTo(-90, 10);
  });
});

describe("rectFromPoints", () => {
  it("normalizes corners regardless of drag direction", () => {
    expect(rectFromPoints({ x: 10, y: 10 }, { x: 0, y: 4 })).toEqual({
      x: 0,
      y: 4,
      width: 10,
      height: 6,
    });
  });
});

describe("aspectRatio", () => {
  it("names 1920x1080 as 16:9", () => {
    expect(aspectRatio(1920, 1080)).toBe("16:9");
  });

  it("names 1024x768 as 4:3", () => {
    expect(aspectRatio(1024, 768)).toBe("4:3");
  });

  it("falls back to a reduced fraction for an uncommon ratio", () => {
    expect(aspectRatio(1000, 300)).toBe("10:3");
  });

  it("returns Unknown for zero or negative dimensions", () => {
    expect(aspectRatio(0, 100)).toBe("Unknown");
    expect(aspectRatio(100, -1)).toBe("Unknown");
  });
});

describe("formatMeasurement", () => {
  it("leads with the chosen unit and lists the others", () => {
    const m = pxToUnits(96, {});
    expect(formatMeasurement(m, "px")).toMatch(/^96 px \(/);
    expect(formatMeasurement(m, "mm")).toMatch(/^25\.40 mm \(/);
    expect(formatMeasurement(m, "in")).toMatch(/^1\.000 in \(/);
  });
});

describe("describeDisplay", () => {
  it("reports CSS vs device pixel resolution", () => {
    const out = describeDisplay({ width: 1000, height: 500, dpr: 2, availWidth: 1000, availHeight: 480 });
    expect(out["CSS resolution"]).toContain("1000 x 500 px");
    expect(out["Device pixel resolution"]).toContain("2000 x 1000 px");
    expect(out["Device pixel ratio"]).toBe("2x");
    expect(out["Available screen area"]).toContain("1000 x 480 px");
  });

  it("omits available area when not provided", () => {
    const out = describeDisplay({ width: 800, height: 600, dpr: 1 });
    expect(out["Available screen area"]).toBeUndefined();
  });
});

describe("rgbaToHex", () => {
  it("formats opaque colours as 6 digit hex", () => {
    expect(rgbaToHex(255, 0, 0)).toBe("#ff0000");
    expect(rgbaToHex(0, 255, 0)).toBe("#00ff00");
  });

  it("appends an alpha byte for translucent colours", () => {
    expect(rgbaToHex(0, 0, 0, 0.5)).toBe("#00000080");
  });

  it("clamps out of range channels", () => {
    expect(rgbaToHex(300, -10, 128)).toBe("#ff0080");
  });
});

describe("contrastRatio", () => {
  it("reports 21:1 for black on white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 4);
  });

  it("is order independent", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 4);
  });

  it("reports 1:1 for identical colours", () => {
    expect(contrastRatio("#336699", "#336699")).toBeCloseTo(1, 4);
  });

  it("throws a ToolError for an invalid hex colour", () => {
    expect(() => contrastRatio("not-a-color", "#fff")).toThrowError(ToolError);
  });
});

describe("nearestCssColorName", () => {
  it("matches pure primaries exactly", () => {
    expect(nearestCssColorName("#ff0000")).toBe("red");
    expect(nearestCssColorName("#0000ff")).toBe("blue");
  });

  it("finds the closest name for an off-shade colour", () => {
    expect(nearestCssColorName("#fefefe")).toBe("white");
  });
});

describe("run", () => {
  const baseOpts = { units: "px", dpr: 1 };

  it("explains the tool for empty input", () => {
    const out = run("", baseOpts);
    expect(out["Other pages and windows"]).toMatch(/cannot see or measure/);
    expect(out["Calibrate for real units"]).toMatch(/85\.60 mm/);
  });

  it("explains the tool for undefined input", () => {
    const out = run(undefined, baseOpts);
    expect(Object.keys(out).length).toBeGreaterThan(0);
  });

  it("measures a text pair of points", () => {
    const out = run("0,0 3,4", baseOpts);
    expect(out["Distance"]).toMatch(/^5 px/);
    expect(out["Point A"]).toBe("(0, 0) px");
    expect(out["Point B"]).toBe("(3, 4) px");
    expect(out["Device pixel ratio"]).toBe("1x");
  });

  it("measures a JSON point pair", () => {
    const out = run('{"points":[[0,0],[3,4]]}', baseOpts);
    expect(out["Distance"]).toMatch(/^5 px/);
    expect(out["Width"]).toMatch(/^3 px/);
    expect(out["Height"]).toMatch(/^4 px/);
  });

  it("uses the mm unit as the leading measurement when selected", () => {
    const out = run("0,0 96,0", { units: "mm", dpr: 1 });
    expect(out["Distance"]).toMatch(/^25\.40 mm/);
  });

  it("uses dpr from JSON input over the option default", () => {
    const out = run('{"points":[[0,0],[10,0]],"dpr":2}', baseOpts);
    expect(out["Device pixel ratio"]).toBe("2x");
  });

  it("applies calibration from JSON input", () => {
    const out = run('{"points":[[0,0],[200,0]],"calibrationPxPerMm":2}', { units: "mm", dpr: 1 });
    expect(out["Distance"]).toMatch(/^100\.00 mm/);
    expect(out["Calibration"]).toMatch(/calibrated/);
  });

  it("reports aspect ratio for a rectangle", () => {
    const out = run("0,0 1920,1080", baseOpts);
    expect(out["Aspect ratio"]).toBe("16:9");
  });

  it("includes display rows when a display snapshot is supplied", () => {
    const out = run(
      '{"points":[[0,0],[1,1]],"display":{"width":1000,"height":500,"dpr":2}}',
      baseOpts,
    );
    expect(out["CSS resolution"]).toContain("1000 x 500 px");
    expect(out["Device pixel resolution"]).toContain("2000 x 1000 px");
  });

  it("throws bad-points for the wrong number of text tokens", () => {
    try {
      run("0,0 1,1 2,2", baseOpts);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-points");
    }
  });

  it("throws bad-points for a non-numeric coordinate", () => {
    try {
      run("0,0 a,b", baseOpts);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-points");
    }
  });

  it("throws bad-points when the JSON points field is missing", () => {
    try {
      run('{"foo":1}', baseOpts);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-points");
    }
  });

  it("throws bad-json for malformed JSON", () => {
    try {
      run('{"points":[[0,0],[1,1]]', baseOpts);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-json");
    }
  });

  it("throws bad-json for a malformed display field", () => {
    try {
      run('{"points":[[0,0],[1,1]],"display":{"width":"x"}}', baseOpts);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-json");
    }
  });

  it("throws bad-option for unknown units", () => {
    try {
      run("0,0 1,1", { units: "furlongs", dpr: 1 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-option");
    }
  });

  it("throws bad-option for dpr out of range", () => {
    try {
      run("0,0 1,1", { units: "px", dpr: 10 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-option");
    }
  });

  it("throws bad-option for a non-positive calibrationPxPerMm", () => {
    try {
      run('{"points":[[0,0],[1,1]],"calibrationPxPerMm":-2}', baseOpts);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-option");
    }
  });

  it("accepts unit synonyms", () => {
    const out = run("0,0 96,0", { units: "inches", dpr: 1 });
    expect(out["Distance"]).toMatch(/^1\.000 in/);
  });
});
