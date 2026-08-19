import { describe, expect, it } from "vitest";
import {
  coverageGrid,
  describePointerType,
  distanceBetween,
  maxSimultaneous,
  pinchScale,
  pressureStats,
  rotation,
  run,
  summarizeTouches,
  type TouchHistory,
  type TouchPoint,
} from "./index";
import { ToolError } from "../types";

describe("summarizeTouches", () => {
  it("summarizes an empty point set", () => {
    const rows = summarizeTouches([]);
    expect(rows["Active points"]).toBe("0");
    expect(rows["Max simultaneous"]).toBe("(not tracked)");
    expect(rows["Pointer types seen"]).toBe("(none)");
  });

  it("produces one labeled line per point with coordinates, pressure, and radius", () => {
    const points: TouchPoint[] = [
      { id: 0, x: 100, y: 200, pressure: 0.5, radiusX: 12, radiusY: 10, pointerType: "touch" },
      { id: 1, x: 300.44, y: 50.06, pointerType: "pen" },
    ];
    const rows = summarizeTouches(points, 3);
    expect(rows["Active points"]).toBe("2");
    expect(rows["Max simultaneous"]).toBe("3");
    expect(rows["Pointer types seen"]).toBe("Touch (finger), Pen / stylus");
    expect(rows["Point 0"]).toContain("x=100, y=200");
    expect(rows["Point 0"]).toContain("pressure=0.50");
    expect(rows["Point 0"]).toContain("radius=12x10");
    expect(rows["Point 1"]).toContain("x=300.4, y=50.1");
  });
});

describe("maxSimultaneous", () => {
  it("returns 0 for an empty history", () => {
    expect(maxSimultaneous([])).toBe(0);
  });

  it("returns the largest snapshot size across the history", () => {
    const history: TouchHistory = [
      [{ id: 0, x: 0, y: 0 }],
      [
        { id: 0, x: 0, y: 0 },
        { id: 1, x: 10, y: 10 },
        { id: 2, x: 20, y: 20 },
      ],
      [],
    ];
    expect(maxSimultaneous(history)).toBe(3);
  });
});

describe("coverageGrid", () => {
  it("marks no cells and reports 0 percent when the viewport size is unknown", () => {
    const result = coverageGrid([[{ id: 0, x: 10, y: 10 }]], 0, 0, 10, 10);
    expect(result.coveragePercent).toBe(0);
    expect(result.grid.every((row) => row.every((cell) => cell === false))).toBe(true);
  });

  it("reports 50 percent when exactly half the cells are ever touched", () => {
    // 10x10 grid over a 100x100 viewport: touch every cell in the left half (x < 50).
    const history: TouchHistory = [];
    for (let row = 0; row < 10; row++) {
      const snapshot: TouchPoint[] = [];
      for (let col = 0; col < 5; col++) {
        snapshot.push({ id: `${row}-${col}`, x: col * 10 + 5, y: row * 10 + 5 });
      }
      history.push(snapshot);
    }
    const result = coverageGrid(history, 100, 100, 10, 10);
    expect(result.coveragePercent).toBe(50);
    for (let row = 0; row < 10; row++) {
      for (let col = 0; col < 10; col++) {
        expect(result.grid[row][col]).toBe(col < 5);
      }
    }
  });
});

describe("pressureStats", () => {
  it("reports no pressure support when every sample is a constant 0", () => {
    const stats = pressureStats([0, 0, 0, 0]);
    expect(stats.min).toBe(0);
    expect(stats.max).toBe(0);
    expect(stats.avg).toBe(0);
    expect(stats.supportsPressure).toBe(false);
  });

  it("reports support when samples vary", () => {
    const stats = pressureStats([0.1, 0.5, 0.9, 0.3]);
    expect(stats.min).toBe(0.1);
    expect(stats.max).toBe(0.9);
    expect(stats.avg).toBeCloseTo(0.45, 5);
    expect(stats.supportsPressure).toBe(true);
  });

  it("handles an empty sample list", () => {
    const stats = pressureStats([]);
    expect(stats).toEqual({ min: 0, max: 0, avg: 0, supportsPressure: false });
  });
});

describe("distanceBetween", () => {
  it("computes straight-line distance", () => {
    expect(distanceBetween({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});

describe("pinchScale", () => {
  it("returns 2 when the distance between two fingers doubles", () => {
    const scale = pinchScale({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { x: 20, y: 0 });
    expect(scale).toBe(2);
  });

  it("returns 1 when the starting distance is zero", () => {
    expect(pinchScale({ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 0, y: 0 }, { x: 20, y: 0 })).toBe(1);
  });
});

describe("rotation", () => {
  it("detects a 90 degree turn", () => {
    const deg = rotation({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 10 });
    expect(deg).toBeCloseTo(90, 5);
  });

  it("returns 0 for no rotation", () => {
    const deg = rotation({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }, { x: 15, y: 5 });
    expect(deg).toBeCloseTo(0, 5);
  });
});

describe("describePointerType", () => {
  it("labels known pointer types", () => {
    expect(describePointerType("touch")).toBe("Touch (finger)");
    expect(describePointerType("pen")).toBe("Pen / stylus");
    expect(describePointerType("mouse")).toBe("Mouse");
  });

  it("falls back to Unknown for anything else", () => {
    expect(describePointerType(undefined)).toBe("Unknown");
    expect(describePointerType("eraser")).toBe("Unknown");
  });
});

describe("run", () => {
  it("returns instructions on empty input", () => {
    const out = run("", {});
    expect(out["Status"]).toMatch(/no touch data/i);
    expect(out["Instructions"]).toMatch(/touch the screen/i);
    expect(out["Next steps"]).toMatch(/dead zone/i);
  });

  it("summarizes a live report by default", () => {
    const out = run(
      JSON.stringify({
        points: [
          { id: 0, x: 100, y: 200, pressure: 0.5, pointerType: "touch" },
          { id: 1, x: 300, y: 400, pointerType: "touch" },
        ],
        maxSeen: 3,
      }),
      {},
    );
    expect(out["Active points"]).toBe("2");
    expect(out["Max simultaneous"]).toBe("3");
    expect(out["Distance between points"]).toBeDefined();
  });

  it("computes pinch and rotation from a two-point history", () => {
    const out = run(
      JSON.stringify({
        points: [
          { id: 0, x: 0, y: 0 },
          { id: 1, x: 20, y: 0 },
        ],
        history: [
          [
            { id: 0, x: 0, y: 0 },
            { id: 1, x: 10, y: 0 },
          ],
          [
            { id: 0, x: 0, y: 0 },
            { id: 1, x: 20, y: 0 },
          ],
        ],
      }),
      {},
    );
    expect(out["Pinch scale"]).toBe("2.00x");
  });

  it("reports coverage percent in coverage view", () => {
    const out = run(
      JSON.stringify({
        points: [],
        history: [[{ id: 0, x: 5, y: 5 }]],
        viewport: { width: 100, height: 100 },
      }),
      { view: "coverage", gridCols: 10 },
    );
    expect(out["Grid size"]).toBe("10 x 16");
    expect(out["Coverage"]).toMatch(/%$/);
    expect(out["Coverage grid"]).toBeDefined();
  });

  it("notes missing viewport size in coverage view", () => {
    const out = run(JSON.stringify({ points: [{ id: 0, x: 5, y: 5 }] }), { view: "coverage" });
    expect(out["Note"]).toMatch(/viewport/i);
    expect(out["Coverage grid"]).toBeUndefined();
  });

  it("reports pressure stats in pressure view", () => {
    const out = run(
      JSON.stringify({
        points: [
          { id: 0, x: 0, y: 0, pressure: 0, pointerType: "touch" },
          { id: 1, x: 0, y: 0, pressure: 0, pointerType: "touch" },
        ],
      }),
      { view: "pressure" },
    );
    expect(out["Samples"]).toBe("2");
    expect(out["Supports pressure"]).toMatch(/^no/);
  });

  it("rejects malformed JSON with an actionable error", () => {
    expect(() => run("{not valid json", {})).toThrowError(ToolError);
    try {
      run("{not valid json", {});
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-json");
      expect((e as ToolError).fix).toMatch(/"points"/);
    }
  });

  it("rejects a JSON value that isn't a touch report", () => {
    expect(() => run(JSON.stringify({ foo: "bar" }), {})).toThrowError(ToolError);
    try {
      run(JSON.stringify([1, 2, 3]), {});
    } catch (e) {
      expect((e as ToolError).code).toBe("not-a-report");
    }
  });

  it("rejects a report whose points field is not an array", () => {
    try {
      run(JSON.stringify({ points: "nope" }), {});
      throw new Error("expected ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("not-a-report");
    }
  });
});
