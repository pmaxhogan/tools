import { describe, expect, it } from "vitest";
import {
  analyzeMesh,
  fitPlane,
  interpolateMesh,
  parseMesh,
  renderHeatmapSvg,
  renderIsometricSvg,
  run,
} from "./index";
import { ToolError } from "../types";

const OPTS = { svg: false, centerOn: "zero", zScale: 10 };

/** Klipper BED_MESH_OUTPUT as Mainsail echoes it, with the // prefixes. */
const KLIPPER_CONSOLE = [
  "Recv: // Mesh Leveling Probed Z positions:",
  "Recv: // -0.100000, -0.075000, -0.050000, -0.025000, 0.000000",
  "Recv: // -0.075000, -0.050000, -0.025000, 0.000000, 0.025000",
  "Recv: // -0.050000, -0.025000, 0.000000, 0.025000, 0.050000",
  "Recv: // -0.025000, 0.000000, 0.025000, 0.050000, 0.075000",
  "Recv: // 0.000000, 0.025000, 0.050000, 0.075000, 0.125000",
].join("\n");

/** A saved mesh straight out of printer.cfg. */
const KLIPPER_CONFIG = [
  "[stepper_z]",
  "position_endstop: 0.5",
  "",
  "[bed_mesh default]",
  "version = 1",
  "points =",
  "  -0.022500, -0.011250, 0.001250",
  "  -0.017500, -0.006250, 0.003750",
  "  -0.012500, -0.001250, 0.008750",
  "x_count = 3",
  "y_count = 3",
  "mesh_x_pps = 2",
  "algo = lagrange",
  "tension = 0.2",
  "min_x = 30.0",
  "max_x = 200.0",
  "min_y = 35.0",
  "max_y = 195.0",
].join("\n");

/** Marlin G29 T bilinear grid, row and column labels included. */
const MARLIN_BILINEAR = [
  "Recv: Bilinear Leveling Grid:",
  "Recv:       0      1      2      3",
  "Recv:  0 -0.017 -0.010 +0.003 +0.017",
  "Recv:  1 -0.005 +0.002 +0.010 +0.020",
  "Recv:  2 +0.008 +0.012 +0.018 +0.030",
  "Recv:  3 +0.015 +0.022 +0.028 +0.040",
  "Recv: ok",
].join("\n");

/** Marlin UBL map, which prints the back of the bed first. */
const MARLIN_UBL = [
  "Unified Bed Leveling System v1.01 ACTIVE",
  "Mesh Z values:",
  "           0          1          2",
  " 2 |    +0.030     +0.035     +0.040",
  " 1 |    +0.010     +0.015     +0.020",
  " 0 |    -0.010     -0.005     +0.000",
].join("\n");

/** A perfect plane: 0.06 mm of rise across X, 0.09 mm across Y. */
const TILTED = [
  "0.00 0.02 0.04 0.06",
  "0.03 0.05 0.07 0.09",
  "0.06 0.08 0.10 0.12",
  "0.09 0.11 0.13 0.15",
].join("\n");

/** Symmetric bowl: no tilt at all, every bit of the range is warp. */
const BOWL = JSON.stringify(
  Array.from({ length: 5 }, (_unusedRow, j) =>
    Array.from({ length: 5 }, (_unusedCell, i) => 0.03 * ((i - 2) ** 2 + (j - 2) ** 2)),
  ),
);

const FLAT = JSON.stringify([
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
]);

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("parsing", () => {
  it("reads a 5x5 Klipper BED_MESH_OUTPUT paste", () => {
    const mesh = parseMesh(KLIPPER_CONSOLE);
    expect(mesh.source).toBe("klipper-console");
    expect(mesh.xCount).toBe(5);
    expect(mesh.yCount).toBe(5);
    expect(mesh.rows[0][0]).toBe(-0.1);
    expect(mesh.rows[4][4]).toBe(0.125);
  });

  it("reports exact statistics for the Klipper fixture", () => {
    const stats = analyzeMesh(parseMesh(KLIPPER_CONSOLE));
    expect(stats.min).toBeCloseTo(-0.1, 12);
    expect(stats.max).toBeCloseTo(0.125, 12);
    expect(stats.range).toBeCloseTo(0.225, 12);
    expect(stats.mean).toBeCloseTo(0.001, 12);

    const out = run(KLIPPER_CONSOLE, OPTS);
    expect(out.Min).toContain("-0.1000 mm");
    expect(out.Max).toContain("+0.1250 mm");
    expect(out.Range).toBe("0.2250 mm of total deviation");
    expect(out.Mean).toBe("+0.0010 mm");
    expect(out.Source).toBe("Klipper BED_MESH_OUTPUT console text");
    expect(out["Grid size"]).toContain("5 by 5 points");
  });

  it("reads a saved [bed_mesh default] section and its bed coordinates", () => {
    const mesh = parseMesh(KLIPPER_CONFIG);
    expect(mesh.source).toBe("klipper-config");
    expect(mesh.xCount).toBe(3);
    expect(mesh.yCount).toBe(3);
    expect(mesh.minX).toBe(30);
    expect(mesh.maxX).toBe(200);
    expect(mesh.minY).toBe(35);
    expect(mesh.maxY).toBe(195);
    expect(mesh.rows[2][2]).toBe(0.00875);

    const out = run(KLIPPER_CONFIG, OPTS);
    expect(out["Grid size"]).toContain("covering X 30.0 to 200.0 mm, Y 35.0 to 195.0 mm");
    expect(out.Max).toContain("(X 200.0 mm, Y 195.0 mm)");
  });

  it("reads a Marlin bilinear grid with row and column labels", () => {
    const mesh = parseMesh(MARLIN_BILINEAR);
    expect(mesh.source).toBe("marlin-grid");
    expect(mesh.xCount).toBe(4);
    expect(mesh.yCount).toBe(4);
    expect(mesh.rows[0]).toEqual([-0.017, -0.01, 0.003, 0.017]);
    expect(mesh.rows[3][3]).toBe(0.04);
    expect(run(MARLIN_BILINEAR, OPTS).Verdict).toMatch(/^Excellent\./);
  });

  it("flips a UBL map so row 0 is the front of the bed", () => {
    const mesh = parseMesh(MARLIN_UBL);
    expect(mesh.xCount).toBe(3);
    expect(mesh.yCount).toBe(3);
    expect(mesh.rows[0]).toEqual([-0.01, -0.005, 0]);
    expect(mesh.rows[2]).toEqual([0.03, 0.035, 0.04]);
  });

  it("reads a JSON array of arrays", () => {
    const mesh = parseMesh("[[0, 0.1], [0.2, 0.3]]");
    expect(mesh.source).toBe("json");
    expect(mesh.xCount).toBe(2);
    expect(mesh.yCount).toBe(2);
    expect(mesh.rows[1]).toEqual([0.2, 0.3]);
  });

  it("reads a plain whitespace separated grid", () => {
    const mesh = parseMesh(TILTED);
    expect(mesh.source).toBe("plain-grid");
    expect(mesh.xCount).toBe(4);
    expect(mesh.yCount).toBe(4);
  });
});

describe("tilt plane", () => {
  it("recovers the exact slopes of a perfectly tilted bed", () => {
    const mesh = parseMesh(TILTED);
    const plane = fitPlane(mesh);
    expect(plane.a).toBeCloseTo(0.06, 10);
    expect(plane.b).toBeCloseTo(0.09, 10);

    const stats = analyzeMesh(mesh);
    expect(stats.tiltX).toBeCloseTo(0.06, 10);
    expect(stats.tiltY).toBeCloseTo(0.09, 10);
    expect(stats.residualRange).toBeCloseTo(0, 10);
    expect(stats.tiltShare).toBeCloseTo(1, 9);

    const out = run(TILTED, OPTS);
    expect(out["Tilt across X"]).toContain("+0.0600 mm");
    expect(out["Tilt across X"]).toContain("right side sits higher");
    expect(out["Tilt across Y"]).toContain("+0.0900 mm");
    expect(out["Tilt across Y"]).toContain("back side sits higher");
    expect(out.Advice).toMatch(/tramming problem/i);
  });

  it("finds no tilt in a symmetric bowl, so the whole range is warp", () => {
    const stats = analyzeMesh(parseMesh(BOWL));
    expect(stats.tiltX).toBeCloseTo(0, 12);
    expect(stats.tiltY).toBeCloseTo(0, 12);
    expect(stats.range).toBeCloseTo(0.24, 10);
    expect(stats.residualRange).toBeCloseTo(stats.range, 12);
    expect(stats.tiltShare).toBeCloseTo(0, 10);

    const out = run(BOWL, OPTS);
    expect(out["Tilt across X"]).toBe("0.0000 mm, level across X");
    expect(out["Tilt across Y"]).toBe("0.0000 mm, level across Y");
    expect(out.Advice).toMatch(/bowed or warped/i);
    expect(out["Tilt across X"]).not.toContain("-0.0000");
  });

  it("names the worst point", () => {
    const stats = analyzeMesh(parseMesh(KLIPPER_CONSOLE));
    expect(stats.worst.xIndex).toBe(4);
    expect(stats.worst.yIndex).toBe(4);
    expect(stats.worst.value).toBe(0.125);
    expect(run(KLIPPER_CONSOLE, OPTS)["Worst point"]).toBe(
      "+0.1250 mm at column 4, row 4, 0.1240 mm away from the mesh average",
    );
  });

  it("reports the four corners and the middle of the bed", () => {
    const out = run(BOWL, OPTS);
    expect(out["Corners and center"]).toBe(
      "front left +0.2400 mm, front right +0.2400 mm, back left +0.2400 mm, back right +0.2400 mm, center 0.0000 mm",
    );
  });
});

describe("verdict thresholds", () => {
  const gridFor = (range: number): string =>
    JSON.stringify([
      [0, range / 2],
      [range / 3, range],
    ]);

  it("calls anything under 0.1 mm excellent", () => {
    expect(run(gridFor(0.05), OPTS).Verdict).toMatch(/^Excellent\./);
  });

  it("calls 0.1 to 0.2 mm good", () => {
    expect(run(gridFor(0.1), OPTS).Verdict).toMatch(/^Good\./);
    expect(run(gridFor(0.2), OPTS).Verdict).toMatch(/^Good\./);
  });

  it("calls 0.2 to 0.35 mm acceptable", () => {
    expect(run(gridFor(0.3), OPTS).Verdict).toMatch(/^Acceptable\./);
    expect(run(gridFor(0.35), OPTS).Verdict).toMatch(/^Acceptable\./);
  });

  it("calls anything above 0.35 mm a tramming job", () => {
    expect(run(gridFor(0.5), OPTS).Verdict).toMatch(/^Needs tramming\./);
  });
});

describe("interpolateMesh", () => {
  it("upsamples bilinearly and keeps the original probe points", () => {
    const mesh = parseMesh("[[0, 1], [2, 3]]");
    const fine = interpolateMesh(mesh, 2);
    expect(fine.xCount).toBe(3);
    expect(fine.yCount).toBe(3);
    expect(fine.rows[0][0]).toBeCloseTo(0, 12);
    expect(fine.rows[0][2]).toBeCloseTo(1, 12);
    expect(fine.rows[2][2]).toBeCloseTo(3, 12);
    expect(fine.rows[1][1]).toBeCloseTo(1.5, 12);
  });

  it("clamps the factor and copies the rows at factor 1", () => {
    const mesh = parseMesh("[[0, 1], [2, 3]]");
    const same = interpolateMesh(mesh, 0);
    expect(same.xCount).toBe(2);
    expect(same.rows).not.toBe(mesh.rows);
    expect(interpolateMesh(mesh, 99).xCount).toBe(9);
  });
});

describe("renderers", () => {
  it("draws one rect per probe point and is deterministic", () => {
    const mesh = parseMesh(KLIPPER_CONSOLE);
    const svg = renderHeatmapSvg(mesh);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(count(svg, 'class="cell"')).toBe(25);
    expect(svg).toBe(renderHeatmapSvg(mesh));
    expect(svg).not.toContain("NaN");
    expect(svg).not.toContain("undefined");
  });

  it("draws one quad per grid cell in painter's order and is deterministic", () => {
    const mesh = parseMesh(KLIPPER_CONSOLE);
    const svg = renderIsometricSvg(mesh, { zScale: 10 });
    expect(count(svg, "<polygon")).toBe(16);
    expect(svg).toBe(renderIsometricSvg(mesh, { zScale: 10 }));
    expect(svg).not.toContain("NaN");
    expect(renderIsometricSvg(mesh, { zScale: 40 })).not.toBe(svg);
  });

  it("moves the neutral colour when centred on the mesh average", () => {
    const mesh = parseMesh(KLIPPER_CONSOLE);
    expect(renderHeatmapSvg(mesh, { palette: "mean" })).not.toBe(
      renderHeatmapSvg(mesh, { palette: "zero" }),
    );
  });

  it("survives a perfectly flat mesh without dividing by zero", () => {
    const mesh = parseMesh(FLAT);
    expect(renderHeatmapSvg(mesh)).not.toContain("NaN");
    expect(renderIsometricSvg(mesh)).not.toContain("NaN");

    const out = run(FLAT, OPTS);
    expect(out.Verdict).toMatch(/^Excellent\./);
    expect(out.Range).toBe("0.0000 mm of total deviation");
    expect(out.Advice).toMatch(/nothing here worth adjusting/i);
    expect(Object.values(out).join(" ")).not.toContain("NaN");
  });

  it("adds the SVG rows only when the option is on", () => {
    expect(run(KLIPPER_CONSOLE, OPTS)["Heatmap SVG"]).toBeUndefined();

    const out = run(KLIPPER_CONSOLE, { ...OPTS, svg: true });
    expect(out["Heatmap SVG"].startsWith("<svg")).toBe(true);
    expect(out["3D SVG"].startsWith("<svg")).toBe(true);
  });
});

describe("errors", () => {
  it("rejects empty input", () => {
    expect(() => run("", OPTS)).toThrow(ToolError);
    try {
      run("   \n  ", OPTS);
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("empty-input");
    }
  });

  it("rejects text with no numeric grid in it", () => {
    try {
      run("no numbers in this paste at all", OPTS);
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("unparseable");
      expect((err as ToolError).fix).toContain("same number of values");
    }
  });

  it("names the row when the grid is ragged", () => {
    const ragged = ["0.10 0.20 0.30", "0.40 0.50", "0.60 0.70 0.80"].join("\n");
    try {
      run(ragged, OPTS);
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("ragged");
      expect((err as ToolError).message).toBe(
        "Mesh row 2 (input line 2) has 2 values, but row 1 has 3.",
      );
    }
  });

  it("names the row when a JSON grid is ragged", () => {
    try {
      run("[[0.1, 0.2], [0.3]]", OPTS);
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("ragged");
      expect((err as ToolError).message).toContain("JSON array index 1");
    }
  });

  it("rejects a mesh smaller than 2 by 2", () => {
    for (const input of ["[[0.1, 0.2]]", "0.1 0.2 0.3", "[[0.1], [0.2]]"]) {
      try {
        run(input, OPTS);
        expect.unreachable();
      } catch (err) {
        expect((err as ToolError).code).toBe("too-small");
      }
    }
  });
});
