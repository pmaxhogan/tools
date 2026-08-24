import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  INK_DOCUMENT_VERSION,
  MAX_PRESSURE_SCALE,
  MIN_PRESSURE_SCALE,
  type Stroke,
  isEmptyInk,
  pressureScale,
  run,
  segmentWidth,
  simplifyStroke,
  smoothStroke,
  strokeBounds,
  strokesBounds,
  strokesFromJson,
  strokesToJson,
  strokesToSvg,
} from "./index";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

function stroke(points: [number, number, number?][], color = "#101010", baseWidth = 3): Stroke {
  return {
    points: points.map(([x, y, p]) => ({ x, y, p: p ?? 0.5 })),
    color,
    baseWidth,
  };
}

/** A right angle: two straight runs with redundant samples along each one. */
const CORNER = stroke([
  [0, 0],
  [5, 0],
  [10, 0],
  [15, 0],
  [20, 0],
  [20, 5],
  [20, 10],
  [20, 20],
]);

/* ------------------------------------------------------------------ */
/* pressure                                                            */
/* ------------------------------------------------------------------ */

describe("pressureScale", () => {
  it("spans the documented range", () => {
    expect(pressureScale(0)).toBe(MIN_PRESSURE_SCALE);
    expect(pressureScale(1)).toBe(MAX_PRESSURE_SCALE);
    // The resting value pressureless devices report draws at the base width.
    expect(pressureScale(0.5)).toBe(1);
    expect(pressureScale(0.25)).toBeCloseTo(0.75, 10);
    expect(pressureScale(0.75)).toBeCloseTo(1.4, 10);
  });

  it("clamps out of range and non numeric pressure", () => {
    expect(pressureScale(-4)).toBe(MIN_PRESSURE_SCALE);
    expect(pressureScale(9)).toBe(MAX_PRESSURE_SCALE);
    // A device that reports nothing usable lands on the resting value.
    expect(pressureScale(Number.NaN)).toBe(1);
  });
});

describe("segmentWidth", () => {
  const s = stroke([
    [0, 0, 0],
    [10, 0, 1],
  ]);

  it("averages the pressure at both ends", () => {
    expect(segmentWidth(s, s.points[0]!, s.points[1]!)).toBeCloseTo(3, 10);
  });

  it("ignores pressure when asked to", () => {
    expect(segmentWidth(s, s.points[0]!, s.points[1]!, false)).toBe(3);
  });

  it("falls back to a usable width when the base width is nonsense", () => {
    const broken = { ...s, baseWidth: 0 };
    expect(segmentWidth(broken, s.points[0]!, s.points[0]!, false)).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* smoothing                                                           */
/* ------------------------------------------------------------------ */

describe("smoothStroke", () => {
  it("keeps the first and last sample exactly where the pen was", () => {
    const out = smoothStroke(CORNER);
    expect(out.points[0]).toEqual({ x: 0, y: 0, p: 0.5 });
    expect(out.points[out.points.length - 1]).toEqual({ x: 20, y: 20, p: 0.5 });
  });

  it("is deterministic: the same stroke smooths to the same points twice", () => {
    expect(smoothStroke(CORNER)).toEqual(smoothStroke(CORNER));
  });

  it("adds samples through the midpoints of the raw polyline", () => {
    const out = smoothStroke(CORNER, 4);
    // start + first midpoint + 6 interior samples x 4 cuts + end
    expect(out.points).toHaveLength(1 + 1 + 6 * 4 + 1);
    // The second point is the midpoint of the first raw pair.
    expect(out.points[1]).toEqual({ x: 2.5, y: 0, p: 0.5 });
  });

  it("rounds the corner instead of cutting it square", () => {
    const out = smoothStroke(CORNER);
    // No smoothed sample sits exactly on the sharp corner of the raw input.
    const onCorner = out.points.filter((q) => q.x === 20 && q.y === 0);
    expect(onCorner).toHaveLength(0);
  });

  it("carries pressure along the curve", () => {
    const ramp = stroke([
      [0, 0, 0],
      [10, 10, 0.5],
      [20, 0, 1],
    ]);
    const out = smoothStroke(ramp);
    const pressures = out.points.map((q) => q.p);
    expect(Math.min(...pressures)).toBeCloseTo(0, 10);
    expect(Math.max(...pressures)).toBeCloseTo(1, 10);
    // Monotonic ramp in, monotonic ramp out.
    for (let i = 1; i < pressures.length; i += 1) {
      expect(pressures[i]!).toBeGreaterThanOrEqual(pressures[i - 1]! - 1e-9);
    }
  });

  it("leaves strokes with fewer than three points alone", () => {
    const dot = stroke([[3, 4]]);
    const line = stroke([
      [0, 0],
      [10, 10],
    ]);
    expect(smoothStroke(dot).points).toEqual(dot.points);
    expect(smoothStroke(line).points).toEqual(line.points);
  });

  it("copies rather than mutating the input", () => {
    const before = JSON.parse(JSON.stringify(CORNER)) as Stroke;
    smoothStroke(CORNER);
    expect(CORNER).toEqual(before);
  });

  it("rejects a step count it cannot sample", () => {
    expect(() => smoothStroke(CORNER, 0)).toThrow(ToolError);
    expect(() => smoothStroke(CORNER, Number.NaN)).toThrow(/cannot be sampled/);
  });
});

/* ------------------------------------------------------------------ */
/* simplification                                                      */
/* ------------------------------------------------------------------ */

describe("simplifyStroke", () => {
  it("drops points that sit on the line their neighbors already draw", () => {
    const out = simplifyStroke(CORNER, 0.5);
    expect(out.points).toEqual([
      { x: 0, y: 0, p: 0.5 },
      { x: 20, y: 0, p: 0.5 },
      { x: 20, y: 20, p: 0.5 },
    ]);
  });

  it("keeps every point at a tolerance of zero", () => {
    expect(simplifyStroke(CORNER, 0).points).toEqual(CORNER.points);
  });

  it("keeps a detour that is wider than the tolerance", () => {
    const bump = stroke([
      [0, 0],
      [10, 2],
      [20, 0],
    ]);
    expect(simplifyStroke(bump, 1).points).toHaveLength(3);
    expect(simplifyStroke(bump, 5).points).toHaveLength(2);
  });

  it("is deterministic", () => {
    expect(simplifyStroke(CORNER, 0.5)).toEqual(simplifyStroke(CORNER, 0.5));
  });

  it("keeps short strokes and the original endpoints", () => {
    const line = stroke([
      [0, 0],
      [10, 10],
    ]);
    expect(simplifyStroke(line, 100).points).toEqual(line.points);
    const out = simplifyStroke(CORNER, 1000);
    expect(out.points).toEqual([
      { x: 0, y: 0, p: 0.5 },
      { x: 20, y: 20, p: 0.5 },
    ]);
  });

  it("rejects a tolerance that is not a distance", () => {
    expect(() => simplifyStroke(CORNER, -1)).toThrow(ToolError);
    expect(() => simplifyStroke(CORNER, Number.POSITIVE_INFINITY)).toThrow(/not a distance/);
  });
});

/* ------------------------------------------------------------------ */
/* bounds                                                              */
/* ------------------------------------------------------------------ */

describe("strokeBounds and strokesBounds", () => {
  it("boxes one stroke", () => {
    expect(strokeBounds(CORNER)).toEqual({
      minX: 0,
      minY: 0,
      maxX: 20,
      maxY: 20,
      width: 20,
      height: 20,
    });
  });

  it("returns null for a stroke with no points", () => {
    expect(strokeBounds(stroke([]))).toBeNull();
  });

  it("unions several strokes, including negative coordinates", () => {
    const box = strokesBounds([
      CORNER,
      stroke([
        [-10, 5],
        [4, 40],
      ]),
      stroke([]),
    ]);
    expect(box).toEqual({ minX: -10, minY: 0, maxX: 20, maxY: 40, width: 30, height: 40 });
  });

  it("reports a zero sized box for an empty drawing", () => {
    expect(strokesBounds([])).toEqual({
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      width: 0,
      height: 0,
    });
    expect(strokesBounds([stroke([])]).width).toBe(0);
  });
});

describe("isEmptyInk", () => {
  it("is true only when nothing has been drawn", () => {
    expect(isEmptyInk([])).toBe(true);
    expect(isEmptyInk([stroke([])])).toBe(true);
    expect(isEmptyInk([stroke([]), CORNER])).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* SVG                                                                 */
/* ------------------------------------------------------------------ */

describe("strokesToSvg", () => {
  it("builds a standalone SVG with a viewBox around the ink", () => {
    const svg = strokesToSvg([CORNER], { padding: 10, smooth: false, simplify: 0.5 });
    expect(svg.startsWith("<svg xmlns=")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    // padding 10 plus half the widest segment (3 x 1 / 2 = 1.5)
    expect(svg).toContain('viewBox="-11.5 -11.5 43 43"');
    expect(svg).toContain('width="43"');
  });

  it("writes one path per segment so width can vary along a stroke", () => {
    const svg = strokesToSvg([CORNER], { smooth: false, simplify: 0.5 });
    expect(svg.match(/<path /g)).toHaveLength(2);
    expect(svg).toContain('stroke="#101010"');
    expect(svg).toContain('stroke-linecap="round"');
  });

  it("varies stroke-width with pressure and holds it flat when told to", () => {
    const ramp = stroke([
      [0, 0, 0],
      [10, 0, 1],
      [20, 0, 1],
    ]);
    const varied = strokesToSvg([ramp], { smooth: false, simplify: 0 });
    const widths = [...varied.matchAll(/stroke-width="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(new Set(widths).size).toBeGreaterThan(1);

    const flat = strokesToSvg([ramp], { smooth: false, simplify: 0, pressure: false });
    const flatWidths = [...flat.matchAll(/stroke-width="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(new Set(flatWidths)).toEqual(new Set([3]));
  });

  it("draws a single tap as a circle", () => {
    const svg = strokesToSvg([stroke([[5, 5]])]);
    expect(svg).toContain("<circle ");
    expect(svg).not.toContain("<path ");
  });

  it("paints a background only when one is asked for", () => {
    expect(strokesToSvg([CORNER])).not.toContain("<rect ");
    expect(strokesToSvg([CORNER], { background: "transparent" })).not.toContain("<rect ");
    expect(strokesToSvg([CORNER], { background: "#fffdf7" })).toContain('fill="#fffdf7"');
  });

  it("escapes a color that would otherwise break the attribute", () => {
    const svg = strokesToSvg([stroke([[0, 0]], '"><script>')]);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("refuses to build an SVG of nothing", () => {
    expect(() => strokesToSvg([])).toThrow(ToolError);
    expect(() => strokesToSvg([stroke([])])).toThrow(/nothing drawn yet/);
  });
});

/* ------------------------------------------------------------------ */
/* save format                                                         */
/* ------------------------------------------------------------------ */

describe("strokesToJson and strokesFromJson", () => {
  const drawing = [
    CORNER,
    stroke(
      [
        [1, 2, 0.25],
        [3, 4, 0.75],
      ],
      "#5b4bd6",
      6,
    ),
  ];

  it("round trips a drawing without losing anything", () => {
    expect(strokesFromJson(strokesToJson(drawing))).toEqual(drawing);
  });

  it("round trips through the pretty form too", () => {
    const json = strokesToJson(drawing, { pretty: true });
    expect(json).toContain("\n  ");
    expect(strokesFromJson(json)).toEqual(drawing);
  });

  it("stamps the version so a future reader knows what it has", () => {
    expect(JSON.parse(strokesToJson([])).version).toBe(INK_DOCUMENT_VERSION);
    expect(strokesFromJson(strokesToJson([]))).toEqual([]);
  });

  it("fills in a missing pressure, color, or width rather than failing", () => {
    const loaded = strokesFromJson('{"version":1,"strokes":[{"points":[{"x":1,"y":2}]}]}');
    expect(loaded).toEqual([{ points: [{ x: 1, y: 2, p: 0.5 }], color: "#000000", baseWidth: 3 }]);
  });

  it("rejects an empty file", () => {
    expect(() => strokesFromJson("   ")).toThrow(ToolError);
    expect(() => strokesFromJson("")).toThrow(/no drawing in it/);
  });

  it("rejects text that is not JSON", () => {
    expect(() => strokesFromJson("<svg />")).toThrow(/not valid JSON/);
  });

  it("rejects JSON that is not a drawing", () => {
    expect(() => strokesFromJson("[1,2,3]")).toThrow(/top level is not an object/);
    expect(() => strokesFromJson('{"version":1}')).toThrow(/no list of strokes/);
  });

  it("rejects a version it cannot read", () => {
    expect(() => strokesFromJson('{"version":2,"strokes":[]}')).toThrow(/version 2/);
    expect(() => strokesFromJson('{"strokes":[]}')).toThrow(/version undefined/);
  });

  it("rejects a stroke that is malformed", () => {
    expect(() => strokesFromJson('{"version":1,"strokes":[7]}')).toThrow(/is not an object/);
    expect(() => strokesFromJson('{"version":1,"strokes":[{}]}')).toThrow(/no list of points/);
    expect(() => strokesFromJson('{"version":1,"strokes":[{"points":[3]}]}')).toThrow(
      /not an object/,
    );
    expect(() => strokesFromJson('{"version":1,"strokes":[{"points":[{"x":"a","y":2}]}]}')).toThrow(
      /not a number/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

describe("run", () => {
  it("explains the pad, and says plainly that it does not read handwriting", () => {
    const out = run("");
    expect(out["Text recognition"]).toContain("Not included");
    expect(out.Privacy).toContain("your files and inputs never leave your device");
  });

  it("reports on a saved drawing that is pasted in", () => {
    const out = run(strokesToJson([CORNER]));
    expect(out.Strokes).toBe("1");
    expect(out.Points).toBe("8");
    expect(out.Size).toBe("20 x 20 units");
    expect(out.Colors).toBe("#101010");
  });

  it("surfaces a bad saved drawing as a ToolError", () => {
    expect(() => run("{}")).toThrow(ToolError);
  });
});
