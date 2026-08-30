import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  CLIP_PRESETS,
  formatClipPath,
  insertPointNear,
  orderPositionTokens,
  parseClipPath,
  presetShape,
  run,
  toSvgPath,
  trimNumber,
  type ClipShape,
} from "./index";

describe("formatClipPath", () => {
  it("writes a polygon as percentage pairs", () => {
    expect(formatClipPath(presetShape("triangle"))).toBe("polygon(50% 0%, 100% 100%, 0% 100%)");
  });

  it("writes the fill rule only when it is not the default", () => {
    const shape = presetShape("triangle");
    expect(formatClipPath(shape)).not.toContain("evenodd");
    expect(formatClipPath({ ...shape, fillRule: "evenodd" })).toBe(
      "polygon(evenodd, 50% 0%, 100% 100%, 0% 100%)",
    );
  });

  it("writes circles, ellipses, and insets", () => {
    expect(formatClipPath(presetShape("circle"))).toBe("circle(50% at 50% 50%)");
    expect(formatClipPath(presetShape("ellipse"))).toBe("ellipse(50% 35% at 50% 50%)");
    expect(formatClipPath(presetShape("rounded-inset"))).toBe("inset(10% 10% 10% 10% round 12%)");
  });

  it("drops the round clause at zero", () => {
    const shape = { ...presetShape("rounded-inset"), round: 0 };
    expect(formatClipPath(shape)).toBe("inset(10% 10% 10% 10%)");
  });

  it("refuses a polygon with fewer than three points", () => {
    const shape: ClipShape = {
      ...presetShape("triangle"),
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
    };
    try {
      formatClipPath(shape);
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("too-few-points");
    }
  });
});

describe("parseClipPath", () => {
  it("reads a polygon with or without the property name", () => {
    const shape = parseClipPath("clip-path: polygon(50% 0%, 100% 100%, 0% 100%);");
    expect(shape.kind).toBe("polygon");
    expect(shape.points).toEqual([
      { x: 50, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ]);
  });

  it("reads the evenodd fill rule", () => {
    expect(parseClipPath("polygon(evenodd, 0% 0%, 100% 0%, 100% 100%)").fillRule).toBe("evenodd");
  });

  it("reads a circle and an ellipse, including position keywords", () => {
    const circle = parseClipPath("circle(40% at left top)");
    expect(circle.radius).toBe(40);
    expect(circle.centerX).toBe(0);
    expect(circle.centerY).toBe(0);

    const ellipse = parseClipPath("ellipse(30% 60% at 25% 75%)");
    expect(ellipse.radiusX).toBe(30);
    expect(ellipse.radiusY).toBe(60);
    expect(ellipse.centerX).toBe(25);
  });

  it("reads a corner written in either keyword order", () => {
    const a = parseClipPath("circle(40% at top right)");
    expect([a.centerX, a.centerY]).toEqual([100, 0]);
    const b = parseClipPath("circle(40% at right top)");
    expect([b.centerX, b.centerY]).toEqual([100, 0]);
    const c = parseClipPath("ellipse(30% 30% at bottom)");
    expect([c.centerX, c.centerY]).toEqual([50, 100]);
    expect(orderPositionTokens(["top", "left"])).toEqual(["left", "top"]);
  });

  it("expands the inset shorthand the way the box model does", () => {
    const one = parseClipPath("inset(10%)");
    expect([one.top, one.right, one.bottom, one.left]).toEqual([10, 10, 10, 10]);

    const two = parseClipPath("inset(10% 20%)");
    expect([two.top, two.right, two.bottom, two.left]).toEqual([10, 20, 10, 20]);

    const four = parseClipPath("inset(1% 2% 3% 4% round 5%)");
    expect([four.top, four.right, four.bottom, four.left, four.round]).toEqual([1, 2, 3, 4, 5]);
  });

  it("rejects an empty value", () => {
    try {
      parseClipPath("   ");
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("rejects path(), url(), and none with a useful message", () => {
    for (const text of ["none", "url(#mask)", "path('M 0 0 L 10 10 Z')"]) {
      try {
        parseClipPath(text);
        throw new Error(`expected a ToolError for ${text}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ToolError);
        expect((e as ToolError).code).toBe("unsupported-shape");
      }
    }
  });

  it("says plainly that the editor works in percentages", () => {
    try {
      parseClipPath("polygon(0px 0px, 100px 0px, 50px 80px)");
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("unsupported-unit");
    }
  });

  it("rejects a point that is not an x and y pair, and a two point polygon", () => {
    try {
      parseClipPath("polygon(50%, 100% 100%, 0% 100%)");
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-value");
    }
    try {
      parseClipPath("polygon(0% 0%, 100% 100%)");
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("too-few-points");
    }
  });

  it("round-trips every preset", () => {
    for (const preset of CLIP_PRESETS) {
      const text = formatClipPath(preset.shape);
      expect(formatClipPath(parseClipPath(text))).toBe(text);
    }
  });
});

describe("toSvgPath", () => {
  it("writes a polygon as move, lines, and close", () => {
    expect(toSvgPath(presetShape("triangle"), 100, 100)).toBe("M 50 0 L 100 100 L 0 100 Z");
  });

  it("scales to the requested box", () => {
    expect(toSvgPath(presetShape("triangle"), 200, 50)).toBe("M 100 0 L 200 50 L 0 50 Z");
  });

  it("resolves a circle radius against the diagonal reference, not the width", () => {
    // 100 by 100 box: the reference is sqrt(100^2 + 100^2) / sqrt(2) = 100,
    // so a 50% radius is 50.
    expect(toSvgPath(presetShape("circle"), 100, 100)).toContain("a 50 50 ");
    // 200 by 100 box: the reference is sqrt(200^2 + 100^2) / sqrt(2), about
    // 158.114, so the same 50% is about 79.057 and not 100.
    expect(toSvgPath(presetShape("circle"), 200, 100)).toContain("a 79.057 79.057 ");
  });

  it("writes a plain rectangle when the inset has no rounding", () => {
    const path = toSvgPath({ ...presetShape("rounded-inset"), round: 0 }, 100, 100);
    expect(path).toBe("M 10 10 H 90 V 90 H 10 Z");
  });

  it("writes four corner arcs when it does", () => {
    const path = toSvgPath(presetShape("rounded-inset"), 100, 100);
    expect(path.match(/A /g)).toHaveLength(4);
    expect(path.startsWith("M 22 10")).toBe(true);
  });

  it("refuses a polygon with fewer than three points", () => {
    try {
      toSvgPath({ ...presetShape("triangle"), points: [{ x: 0, y: 0 }] });
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("too-few-points");
    }
  });
});

describe("insertPointNear", () => {
  it("adds the point on the nearest edge", () => {
    const shape = presetShape("triangle");
    const next = insertPointNear(shape, 100, 50);
    expect(next.points).toHaveLength(4);
    expect(next.points[1]).toEqual({ x: 100, y: 50 });
  });

  it("leaves a circle alone", () => {
    const circle = presetShape("circle");
    expect(insertPointNear(circle, 10, 10)).toBe(circle);
  });
});

describe("presetShape", () => {
  it("returns a deep copy of the points", () => {
    presetShape("triangle").points[0].x = 999;
    expect(presetShape("triangle").points[0].x).toBe(50);
  });

  it("rejects an unknown preset", () => {
    try {
      presetShape("octagram");
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("unknown-preset");
    }
  });
});

describe("run", () => {
  it("emits the CSS declaration by default", () => {
    expect(run("", {})).toBe("clip-path: polygon(50% 0%, 100% 100%, 0% 100%);");
  });

  it("parses an input value instead of the preset", () => {
    expect(run("circle(30% at 20% 40%)", {})).toBe("clip-path: circle(30% at 20% 40%);");
  });

  it("emits a whole SVG element when asked", () => {
    const out = run("", { preset: "hexagon", format: "svg", width: 100, height: 100 });
    expect(out).toContain('<svg viewBox="0 0 100 100"');
    expect(out).toContain('<path d="M 25 0 L 75 0 L 100 50 L 75 100 L 25 100 L 0 50 Z"');
  });

  it("emits both, with the box size in the comment", () => {
    const out = run("", { format: "both", width: 320, height: 180 });
    expect(out).toContain("clip-path: polygon(");
    expect(out).toContain("a 320 by 180 box");
    expect(out).toContain('viewBox="0 0 320 180"');
  });

  it("carries the fill rule into the SVG element", () => {
    const out = run("polygon(evenodd, 0% 0%, 100% 0%, 50% 100%)", { format: "svg" });
    expect(out).toContain('fill-rule="evenodd"');
  });

  it("rejects bad options", () => {
    expect(() => run("", { format: "canvas" })).toThrowError(ToolError);
    expect(() => run("", { width: 0 })).toThrowError(ToolError);
    expect(() => run("", { preset: "nope" })).toThrowError(ToolError);
  });

  it("keeps trimNumber tidy", () => {
    expect(trimNumber(50, 3)).toBe("50");
    expect(trimNumber(79.0569, 3)).toBe("79.057");
  });
});
