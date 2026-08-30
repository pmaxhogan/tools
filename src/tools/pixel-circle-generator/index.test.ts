import { describe, expect, it } from "vitest";
import {
  gridToAscii,
  gridToRunLengths,
  generateCircleGrid,
  MAX_SIZE,
  MIN_SIZE,
  run,
} from "./index";
import { ToolError } from "../types";

/** True when every row and column of the grid mirrors its opposite. */
function isSymmetric(cells: boolean[][]): boolean {
  const h = cells.length;
  const w = cells[0]!.length;
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const v = cells[row]![col]!;
      if (v !== cells[h - 1 - row]![col]) return false;
      if (v !== cells[row]![w - 1 - col]) return false;
    }
  }
  return true;
}

describe("generateCircleGrid: filled block counts of known sizes", () => {
  // Verified by hand against the boundary formula, and independently
  // matches the counts widely cited by community Minecraft circle charts.
  const known: [number, number][] = [
    [1, 1],
    [2, 4],
    [3, 9],
    [4, 12],
    [5, 21],
    [6, 32],
    [7, 37],
    [8, 52],
    [9, 69],
  ];

  for (const [diameter, count] of known) {
    it(`diameter ${diameter} has ${count} blocks`, () => {
      const grid = generateCircleGrid({
        width: diameter,
        height: diameter,
        mode: "filled",
        thickness: 1,
      });
      expect(grid.blockCount).toBe(count);
    });
  }
});

describe("generateCircleGrid: symmetry", () => {
  for (const d of [1, 2, 5, 8, 17, 64, 255, 256]) {
    it(`is left-right and top-bottom symmetric at diameter ${d}`, () => {
      const grid = generateCircleGrid({ width: d, height: d, mode: "filled", thickness: 1 });
      expect(isSymmetric(grid.cells)).toBe(true);
    });
  }

  it("is symmetric for an outline too", () => {
    const grid = generateCircleGrid({ width: 20, height: 20, mode: "outline", thickness: 3 });
    expect(isSymmetric(grid.cells)).toBe(true);
  });

  it("is symmetric for a non-square ellipse", () => {
    const grid = generateCircleGrid({ width: 30, height: 12, mode: "filled", thickness: 1 });
    expect(isSymmetric(grid.cells)).toBe(true);
  });
});

describe("generateCircleGrid: edge sizes", () => {
  it("the minimum 1x1 grid is a single block", () => {
    const grid = generateCircleGrid({
      width: MIN_SIZE,
      height: MIN_SIZE,
      mode: "filled",
      thickness: 1,
    });
    expect(grid.blockCount).toBe(1);
    expect(grid.cells).toEqual([[true]]);
  });

  it("the maximum 256x256 grid rasterizes without error and stays inside the bounding box", () => {
    const grid = generateCircleGrid({
      width: MAX_SIZE,
      height: MAX_SIZE,
      mode: "filled",
      thickness: 1,
    });
    expect(grid.width).toBe(256);
    expect(grid.blockCount).toBeGreaterThan(0);
    expect(grid.blockCount).toBeLessThanOrEqual(256 * 256);
  });

  it("rejects a width below the minimum", () => {
    expect(() => generateCircleGrid({ width: 0, height: 5, mode: "filled", thickness: 1 })).toThrow(
      ToolError,
    );
  });

  it("rejects a width above the maximum", () => {
    expect(() =>
      generateCircleGrid({ width: 257, height: 5, mode: "filled", thickness: 1 }),
    ).toThrow(ToolError);
  });

  it("rejects a non-integer size", () => {
    expect(() =>
      generateCircleGrid({ width: 5.5, height: 5, mode: "filled", thickness: 1 }),
    ).toThrow(ToolError);
  });
});

describe("generateCircleGrid: outline mode", () => {
  it("matches the hand-verified diameter 5, thickness 1 outline", () => {
    const grid = generateCircleGrid({ width: 5, height: 5, mode: "outline", thickness: 1 });
    expect(grid.blockCount).toBe(12);
    expect(gridToAscii(grid)).toBe([".###.", "#...#", "#...#", "#...#", ".###."].join("\n"));
  });

  it("an outline never has more blocks than the equivalent filled shape", () => {
    const outline = generateCircleGrid({ width: 40, height: 40, mode: "outline", thickness: 3 });
    const filled = generateCircleGrid({ width: 40, height: 40, mode: "filled", thickness: 1 });
    expect(outline.blockCount).toBeLessThan(filled.blockCount);
  });

  it("collapses to the filled shape once thickness reaches the radius", () => {
    const outline = generateCircleGrid({ width: 8, height: 8, mode: "outline", thickness: 10 });
    const filled = generateCircleGrid({ width: 8, height: 8, mode: "filled", thickness: 1 });
    expect(outline.blockCount).toBe(filled.blockCount);
    expect(outline.cells).toEqual(filled.cells);
  });

  it("rejects a non-integer or zero thickness", () => {
    expect(() =>
      generateCircleGrid({ width: 10, height: 10, mode: "outline", thickness: 0 }),
    ).toThrow(ToolError);
    expect(() =>
      generateCircleGrid({ width: 10, height: 10, mode: "outline", thickness: 1.5 }),
    ).toThrow(ToolError);
  });
});

describe("row runs", () => {
  it("gives one run per row for a filled circle", () => {
    const grid = generateCircleGrid({ width: 9, height: 9, mode: "filled", thickness: 1 });
    for (const runs of grid.rowRuns) {
      expect(runs.length).toBeLessThanOrEqual(1);
    }
  });

  it("gives up to two runs per row for an outline", () => {
    const grid = generateCircleGrid({ width: 20, height: 20, mode: "outline", thickness: 2 });
    for (const runs of grid.rowRuns) {
      expect(runs.length).toBeLessThanOrEqual(2);
    }
    // the middle row of a large enough ring has a gap, so it must show two runs
    const middle = grid.rowRuns[10]!;
    expect(middle.length).toBe(2);
  });

  it("run lengths sum to the row's filled cell count", () => {
    const grid = generateCircleGrid({ width: 15, height: 15, mode: "outline", thickness: 2 });
    grid.rowRuns.forEach((runs, i) => {
      const bySum = runs.reduce((acc, r) => acc + r.length, 0);
      const byCount = grid.cells[i]!.filter(Boolean).length;
      expect(bySum).toBe(byCount);
    });
  });
});

describe("gridToAscii / gridToRunLengths", () => {
  it("renders a small filled grid", () => {
    const grid = generateCircleGrid({ width: 3, height: 3, mode: "filled", thickness: 1 });
    expect(gridToAscii(grid)).toBe(["###", "###", "###"].join("\n"));
  });

  it("renders row run text with a start:length per run", () => {
    const grid = generateCircleGrid({ width: 3, height: 3, mode: "filled", thickness: 1 });
    expect(gridToRunLengths(grid)).toBe("Row 0: 0:3\nRow 1: 0:3\nRow 2: 0:3");
  });
});

describe("run", () => {
  it("reports block count and ascii art for a filled circle", () => {
    const out = run(undefined, { width: 5, height: 5, mode: "filled", thickness: 1 });
    expect(out["Block count"]).toBe("21");
    expect(out.Mode).toBe("Filled");
    expect(out["ASCII art"].split("\n")).toHaveLength(5);
  });

  it("reports an outline result", () => {
    const out = run(undefined, { width: 5, height: 5, mode: "outline", thickness: 1 });
    expect(out["Block count"]).toBe("12");
    expect(out.Mode).toBe("Outline, 1 block thick");
  });

  it("throws for an out of range size", () => {
    expect(() => run(undefined, { width: 300, height: 5, mode: "filled", thickness: 1 })).toThrow(
      ToolError,
    );
  });
});
