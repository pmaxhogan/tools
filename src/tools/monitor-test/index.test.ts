import { describe, expect, it } from "vitest";
import {
  TESTS,
  describeTest,
  gammaFromMatch,
  renderPatternSvg,
  run,
} from "./index";
import { ToolError } from "../types";

const DIMS = { width: 800, height: 450 };

describe("TESTS catalog", () => {
  it("has unique ids", () => {
    const ids = TESTS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique labels", () => {
    const labels = TESTS.map((t) => t.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("every test has non-empty purpose and instructions", () => {
    for (const test of TESTS) {
      expect(test.purpose.length).toBeGreaterThan(0);
      expect(test.instructions.length).toBeGreaterThan(0);
      expect(["solid", "gradient", "pattern", "motion", "text"]).toContain(test.kind);
    }
  });

  it("covers every required kind", () => {
    const kinds = new Set(TESTS.map((t) => t.kind));
    expect(kinds).toEqual(new Set(["solid", "gradient", "pattern", "motion", "text"]));
  });
});

describe("renderPatternSvg", () => {
  it("renders a valid svg root for every test", () => {
    for (const test of TESTS) {
      const svg = renderPatternSvg(test.id, DIMS);
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain("</svg>");
      expect(svg).toContain('width="800"');
      expect(svg).toContain('height="450"');
    }
  });

  it("renders a linearGradient for the grayscale gradient test", () => {
    const svg = renderPatternSvg("gradient-gray", DIMS);
    expect(svg).toContain("<linearGradient");
  });

  it("renders a linearGradient for the color gradient test", () => {
    const svg = renderPatternSvg("gradient-color", DIMS);
    expect(svg).toContain("<linearGradient");
  });

  it("renders a pattern for the checkerboard test", () => {
    const svg = renderPatternSvg("checkerboard", DIMS);
    expect(svg).toContain("<pattern");
  });

  it("renders a pattern for the fine grid test", () => {
    const svg = renderPatternSvg("grid-fine", DIMS);
    expect(svg).toContain("<pattern");
  });

  it("renders a pattern for the gamma check stripes", () => {
    const svg = renderPatternSvg("gamma-check", DIMS);
    expect(svg).toContain("<pattern");
  });

  it("renders at least 7 rects for color bars", () => {
    const svg = renderPatternSvg("color-bars", DIMS);
    const rectCount = (svg.match(/<rect/g) ?? []).length;
    expect(rectCount).toBeGreaterThanOrEqual(7);
  });

  it("renders labeled contrast patches with text elements", () => {
    const svg = renderPatternSvg("contrast", DIMS);
    expect(svg).toContain("<text");
    expect(svg).toContain("1%");
    expect(svg).toContain("10%");
  });

  it("renders a solid fill for a plain solid color test", () => {
    const svg = renderPatternSvg("solid-red", DIMS);
    expect(svg).toContain('fill="#ff0000"');
  });

  it("renders a static reference frame for a motion test", () => {
    const svg = renderPatternSvg("ghosting", DIMS);
    expect(svg).toContain("<rect");
  });

  it("falls back to default dimensions for invalid width/height", () => {
    const svg = renderPatternSvg("solid-white", { width: -5, height: NaN as unknown as number });
    expect(svg).toContain('width="800"');
    expect(svg).toContain('height="450"');
  });

  it("throws ToolError bad-test for an unknown id", () => {
    expect(() => renderPatternSvg("not-a-real-test", DIMS)).toThrow(ToolError);
    try {
      renderPatternSvg("not-a-real-test", DIMS);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("bad-test");
    }
  });
});

describe("describeTest", () => {
  it("returns label, kind, purpose, and instructions for a known test", () => {
    const detail = describeTest("gamma-check");
    expect(detail["Label"]).toBe("Gamma check");
    expect(detail["Kind"]).toBe("pattern");
    expect(detail["Purpose"].length).toBeGreaterThan(0);
    expect(detail["Instructions"].length).toBeGreaterThan(0);
  });

  it("throws ToolError bad-test for an unknown id", () => {
    expect(() => describeTest("nope")).toThrow(ToolError);
  });
});

describe("gammaFromMatch", () => {
  it("returns 1 when the match is exactly 0.5", () => {
    expect(gammaFromMatch(0.5)).toBeCloseTo(1, 10);
  });

  it("returns approximately 2.2 when the match is 0.729", () => {
    expect(gammaFromMatch(0.729)).toBeCloseTo(2.2, 1);
  });

  it("throws ToolError for a value outside (0, 1)", () => {
    expect(() => gammaFromMatch(0)).toThrow(ToolError);
    expect(() => gammaFromMatch(1)).toThrow(ToolError);
    expect(() => gammaFromMatch(-0.2)).toThrow(ToolError);
    expect(() => gammaFromMatch(1.5)).toThrow(ToolError);
  });

  it("throws ToolError for a non-finite value", () => {
    expect(() => gammaFromMatch(NaN)).toThrow(ToolError);
    expect(() => gammaFromMatch(Infinity)).toThrow(ToolError);
  });
});

describe("run", () => {
  it("empty input lists every test with a one-line purpose", () => {
    const result = run("", {});
    expect(Object.keys(result).length).toBe(TESTS.length);
    for (const test of TESTS) {
      expect(result[test.label]).toBe(test.purpose);
    }
  });

  it("opts.test 'all' also lists every test", () => {
    const result = run("", { test: "all" });
    expect(Object.keys(result).length).toBe(TESTS.length);
  });

  it("a test id via input returns its instructions", () => {
    const result = run("solid-red", {});
    expect(result["Label"]).toBe("Solid red");
    expect(result["Instructions"].length).toBeGreaterThan(0);
    expect(result["SVG"]).toBeUndefined();
  });

  it("a test id via opts.test returns its instructions when input is empty", () => {
    const result = run("", { test: "checkerboard" });
    expect(result["Label"]).toBe("Checkerboard");
  });

  it("input takes precedence over opts.test when both are set", () => {
    const result = run("solid-blue", { test: "solid-red" });
    expect(result["Label"]).toBe("Solid blue");
  });

  it("includes an SVG row when the svg option is true", () => {
    const result = run("gradient-color", { svg: true });
    expect(result["SVG"]).toBeDefined();
    expect(result["SVG"]!.startsWith("<svg")).toBe(true);
  });

  it("throws ToolError bad-test for an unknown test id", () => {
    try {
      run("totally-unknown", {});
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("bad-test");
    }
  });
});
