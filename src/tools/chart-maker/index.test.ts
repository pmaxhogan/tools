import { describe, expect, it } from "vitest";
import {
  formatNumber,
  niceTicks,
  parseChartData,
  renderChart,
  renderPie,
  resolveOpts,
  run,
  slicePath,
} from "./index";
import { ToolError } from "../types";

const CSV = ["Month,Revenue,Cost,Profit", "Jan,120,80,40", "Feb,150,90,60", "Mar,90,70,20"].join(
  "\n",
);

const DEFAULTS = {
  type: "bar",
  width: 800,
  height: 450,
  legend: true,
  gridlines: true,
  valueLabels: false,
  palette: "site",
};

function marks(svg: string): string[] {
  return svg.match(/<(rect|circle|path)[^>]*data-value=/g) ?? [];
}

describe("chart-maker parsing", () => {
  it("reads a header row and three series", () => {
    const data = parseChartData(CSV);
    expect(data.title).toBeUndefined();
    expect(data.labels).toEqual(["Jan", "Feb", "Mar"]);
    expect(data.series.map((s) => s.name)).toEqual(["Revenue", "Cost", "Profit"]);
    expect(data.series[0].values).toEqual([120, 150, 90]);
    expect(data.series[2].values).toEqual([40, 60, 20]);
  });

  it("auto-detects tab separated data", () => {
    const data = parseChartData("Quarter\tUnits\nQ1\t10\nQ2\t20\nQ3\t35");
    expect(data.labels).toEqual(["Q1", "Q2", "Q3"]);
    expect(data.series).toHaveLength(1);
    expect(data.series[0].name).toBe("Units");
    expect(data.series[0].values).toEqual([10, 20, 35]);
  });

  it("reads thousands separators, currency, percents and accounting negatives", () => {
    const data = parseChartData('Item,Value\nA,"1,234"\nB,$2 500\nC,45%\nD,(250)');
    expect(data.series[0].values).toEqual([1234, 2500, 45, -250]);
  });

  it("turns empty cells into gaps rather than zeros", () => {
    const data = parseChartData("Day,Load\nMon,10\nTue,\nWed,30");
    expect(data.series[0].values).toEqual([10, null, 30]);
  });

  it("treats a numeric first row as data, not as a header", () => {
    const data = parseChartData("Jan,120\nFeb,150");
    expect(data.labels).toEqual(["Jan", "Feb"]);
    expect(data.series[0].name).toBe("Series 1");
    expect(data.series[0].values).toEqual([120, 150]);
  });

  it("charts a bare single column list against row numbers", () => {
    const data = parseChartData("10\n20\n30");
    expect(data.labels).toEqual(["1", "2", "3"]);
    expect(data.series[0].values).toEqual([10, 20, 30]);
  });

  it("takes the title from a leading hash line", () => {
    const data = parseChartData(`# Monthly revenue\n${CSV}`);
    expect(data.title).toBe("Monthly revenue");
    expect(data.labels).toEqual(["Jan", "Feb", "Mar"]);
  });

  it("does not mistake a hashed first cell for a title", () => {
    const data = parseChartData("#,Count\n1,5\n2,9");
    expect(data.title).toBeUndefined();
    expect(data.series[0].name).toBe("Count");
  });
});

describe("chart-maker niceTicks", () => {
  it("picks round steps from the 1 / 2 / 5 family", () => {
    expect(niceTicks(0, 87, 5)).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it("handles fractional domains without floating point dust", () => {
    expect(niceTicks(0, 1, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });

  it("pads a flat domain so a constant series still gets an axis", () => {
    const ticks = niceTicks(5, 5, 5);
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks[0]).toBeLessThan(5);
    expect(ticks[ticks.length - 1]).toBeGreaterThan(5);
  });

  it("spans negative domains and never prints a negative zero", () => {
    const ticks = niceTicks(-30, 30, 5);
    expect(ticks).toEqual([-40, -20, 0, 20, 40]);
    expect(ticks.map(String)).not.toContain("-0");
  });

  it("clamps a silly tick count instead of looping forever", () => {
    expect(niceTicks(0, 10, 0).length).toBeGreaterThan(1);
    expect(niceTicks(Number.NaN, Number.NaN, 5).length).toBeGreaterThan(1);
  });
});

describe("chart-maker rendering", () => {
  it("draws one bar per value with a viewBox and a legend", () => {
    const svg = renderChart(parseChartData(CSV), DEFAULTS);
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain('viewBox="0 0 800 450"');
    expect(svg).toContain('data-chart-type="bar"');
    expect(svg).toContain('data-chart-ink="currentColor"');
    expect(marks(svg)).toHaveLength(9);
    expect(svg).toContain(">Revenue<");
    expect(svg).toContain(">Cost<");
    expect(svg).toContain(">Profit<");
    expect(svg).toContain('data-series="Revenue"');
  });

  it("paints no background and inks every label with currentColor", () => {
    const svg = renderChart(parseChartData(CSV), DEFAULTS);
    expect(svg).not.toContain('width="100%"');
    const fills = svg.match(/<text[^>]*fill="([^"]+)"/g) ?? [];
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.every((tag) => tag.includes('fill="currentColor"'))).toBe(true);
  });

  it("honors the width, height, legend and gridline options", () => {
    const svg = renderChart(parseChartData(CSV), {
      ...DEFAULTS,
      width: 1200,
      height: 600,
      legend: false,
      gridlines: false,
    });
    expect(svg).toContain('viewBox="0 0 1200 600"');
    expect(svg).not.toContain(">Revenue<");
    expect(svg).not.toContain('stroke-opacity="0.12"');
  });

  it("adds a label per value when asked", () => {
    const plain = renderChart(parseChartData("Month,Rev\nJan,120\nFeb,150"), DEFAULTS);
    const labeled = renderChart(parseChartData("Month,Rev\nJan,120\nFeb,150"), {
      ...DEFAULTS,
      valueLabels: true,
    });
    expect(plain).not.toContain(">120<");
    expect(labeled).toContain(">120<");
  });

  it("draws a line as a path and breaks it at gaps", () => {
    const svg = renderChart(parseChartData("Day,Load\nMon,10\nTue,\nWed,30\nThu,25"), {
      ...DEFAULTS,
      type: "line",
    });
    const path = svg.match(/<path d="([^"]+)" fill="none"/);
    expect(path).not.toBeNull();
    expect((path?.[1].match(/M/g) ?? []).length).toBe(2);
  });

  it("fills an area chart under the line", () => {
    const svg = renderChart(parseChartData(CSV), { ...DEFAULTS, type: "area" });
    expect(svg).toContain('fill-opacity="0.18"');
    expect(svg).toMatch(/<path d="[^"]+" fill="none"/);
  });

  it("stacks a stacked bar so each label totals its series", () => {
    const svg = renderChart(parseChartData(CSV), { ...DEFAULTS, type: "stacked-bar" });
    expect(svg).toContain('data-chart-type="stacked-bar"');
    expect(marks(svg)).toHaveLength(9);
  });

  it("swaps the axes for a horizontal bar chart", () => {
    const svg = renderChart(parseChartData(CSV), { ...DEFAULTS, type: "horizontal-bar" });
    expect(svg).toContain('data-chart-type="horizontal-bar"');
    expect(svg).toContain(">Jan<");
    expect(marks(svg)).toHaveLength(9);
  });

  it("uses a real numeric x axis for a scatter over numeric labels", () => {
    const svg = renderChart(parseChartData("x,y\n1,10\n2,20\n5,50"), {
      ...DEFAULTS,
      type: "scatter",
    });
    const xs = [...svg.matchAll(/<circle cx="([-\d.]+)"/g)].map((m) => Number(m[1]));
    expect(xs).toHaveLength(3);
    // x jumps 1 -> 2 -> 5, so the second gap must be three times the first.
    expect((xs[2] - xs[1]) / (xs[1] - xs[0])).toBeCloseTo(3, 1);
  });

  it("groups the tail of a long pie into Other", () => {
    const rows = ["Item,Value"];
    for (let i = 1; i <= 15; i++) rows.push(`Item ${i},${i * 10}`);
    const svg = renderChart(parseChartData(rows.join("\n")), { ...DEFAULTS, type: "pie" });
    expect(svg.match(/<path[^>]*data-label=/g) ?? []).toHaveLength(12);
    expect(svg).toContain('data-label="Other"');
    expect(svg).toContain('data-value="100"');
    expect(svg).toContain("The 4 smallest values are grouped into a slice named Other");
    expect(svg).toMatch(/>\d+(\.\d+)?%</);
  });

  it("cuts a donut hole out of every slice", () => {
    const svg = renderChart(parseChartData("Item,Value\nA,1\nB,2\nC,3"), {
      ...DEFAULTS,
      type: "donut",
    });
    const slice = svg.match(/<path d="([^"]+)"[^>]*data-label="A"/);
    expect(slice).not.toBeNull();
    expect((slice?.[1].match(/A/g) ?? []).length).toBe(2);
  });

  it("renders a single slice pie as a visible full circle", () => {
    const svg = renderChart(parseChartData("Item,Value\nOnly,42"), { ...DEFAULTS, type: "pie" });
    const slice = svg.match(/<path d="([^"]+)"[^>]*data-label="Only"/);
    expect(slice).not.toBeNull();
    expect(slice?.[1]).toContain("A");
    expect(svg).toContain(">100%<");
  });

  it("accepts synonyms for the type and palette", () => {
    expect(renderChart(parseChartData(CSV), { type: "Doughnut" })).toContain(
      'data-chart-type="donut"',
    );
    expect(renderChart(parseChartData(CSV), { type: "hbar" })).toContain(
      'data-chart-type="horizontal-bar"',
    );
    expect(renderChart(parseChartData(CSV), { palette: "monochrome" })).toContain(
      'data-chart-palette="mono"',
    );
  });

  it("escapes markup in labels, series names and the title", () => {
    const svg = renderChart(parseChartData('# A "quoted" <title>\nItem,"Rev ""A"" <b>"\nX,5'), {
      ...DEFAULTS,
    });
    expect(svg).toContain("&quot;");
    expect(svg).toContain("&lt;b&gt;");
    expect(svg).not.toMatch(/data-series="[^"]*"[^ />]/);
    expect(svg).toContain("<title>A &quot;quoted&quot; &lt;title&gt;</title>");
  });

  it("drops a column that parsed to nothing but gaps", () => {
    const data = parseChartData("Month,Rev,Note\nJan,10,alpha\nFeb,20,beta");
    expect(data.series).toHaveLength(2);
    const svg = renderChart(data, DEFAULTS);
    expect(marks(svg)).toHaveLength(2);
    expect(svg).not.toContain(">Note<");
  });

  it("caps a legend that would swallow the canvas and counts off the rest", () => {
    const header = ["Label"];
    for (let i = 0; i < 12; i++) header.push(`Series number ${i}`);
    const rows = [header.join(",")];
    for (let r = 0; r < 3; r++) {
      rows.push([`Row ${r}`, ...Array.from({ length: 12 }, (_, i) => String(r + i))].join(","));
    }
    const svg = renderChart(parseChartData(rows.join("\n")), {
      ...DEFAULTS,
      width: 320,
      height: 200,
    });
    expect(svg).toMatch(/>\+\d+ more</);
    const ys = [...svg.matchAll(/ (?:y|cy|y1|y2)="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
    expect(Math.max(...ys)).toBeLessThanOrEqual(200);
  });

  it("is deterministic", () => {
    expect(run(CSV, DEFAULTS)).toBe(run(CSV, DEFAULTS));
    expect(run(CSV, { ...DEFAULTS, type: "pie" })).toBe(run(CSV, { ...DEFAULTS, type: "pie" }));
  });
});

describe("chart-maker number formatting", () => {
  it("groups thousands and shortens the big units", () => {
    expect(formatNumber(1500)).toBe("1,500");
    expect(formatNumber(2500000)).toBe("2.5M");
    expect(formatNumber(-1234567890)).toBe("-1.23B");
    expect(formatNumber(0.25)).toBe("0.25");
    expect(formatNumber(0)).toBe("0");
  });
});

describe("chart-maker errors", () => {
  it("rejects empty input", () => {
    expect(() => run("", DEFAULTS)).toThrowError(ToolError);
    expect(() => run("   \n  ", DEFAULTS)).toThrowError(/Nothing to chart/);
    try {
      run("", DEFAULTS);
    } catch (err) {
      expect((err as ToolError).code).toBe("empty-input");
    }
  });

  it("rejects input whose every cell is empty", () => {
    try {
      run(",,\n,,", DEFAULTS);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ToolError).code).toBe("empty-input");
    }
  });

  it("rejects unparseable CSV", () => {
    try {
      run('a,b\n"unterminated,2\n3,4', DEFAULTS);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ToolError).code).toBe("invalid-csv");
    }
  });

  it("rejects data with no numbers in it", () => {
    try {
      run("Name,Kind\nA,red\nB,blue", DEFAULTS);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ToolError).code).toBe("no-numbers");
      expect((err as ToolError).message).toContain("No numbers found");
    }
  });

  it("rejects a header with no rows under it", () => {
    try {
      run("Month,Revenue", DEFAULTS);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ToolError).code).toBe("no-numbers");
    }
  });

  it("rejects a pie with nothing above zero", () => {
    try {
      run("Item,Value\nA,0\nB,-5", { ...DEFAULTS, type: "pie" });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ToolError).code).toBe("no-numbers");
      expect((err as ToolError).message).toContain("above zero");
    }
  });

  it("rejects prepared data with no drawable series", () => {
    try {
      renderChart({ labels: ["a", "b"], series: [{ name: "s", values: [null, null] }] }, DEFAULTS);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ToolError).code).toBe("no-numbers");
    }
  });

  it("rejects more cells than a chart can carry", () => {
    const rows = ["Label,A,B"];
    for (let i = 0; i < 3000; i++) rows.push(`row${i},${i},${i * 2}`);
    try {
      run(rows.join("\n"), DEFAULTS);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ToolError).code).toBe("too-many-points");
      expect((err as ToolError).message).toContain("6,000");
    }
  });

  it("rejects sizes outside the supported range", () => {
    for (const opts of [
      { ...DEFAULTS, width: 100 },
      { ...DEFAULTS, width: 2000 },
      { ...DEFAULTS, height: 50 },
      { ...DEFAULTS, height: 4000 },
    ]) {
      try {
        run(CSV, opts);
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as ToolError).code).toBe("bad-option");
      }
    }
  });

  it("rejects a chart type or palette it cannot draw", () => {
    try {
      run(CSV, { ...DEFAULTS, type: "bubble" });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ToolError).code).toBe("bad-option");
      expect((err as ToolError).fix).toContain("stacked-bar");
    }
    try {
      run(CSV, { ...DEFAULTS, palette: "neon" });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ToolError).code).toBe("bad-option");
      expect((err as ToolError).fix).toContain("warm");
    }
  });
});

describe("chart-maker pie internals reused by other tools", () => {
  const DATA = {
    title: "Pool capacity",
    labels: ["Usable", "Parity", "Spare"],
    series: [{ name: "Bytes", values: [16, 8, 4] }],
  };

  it("exports slicePath, resolveOpts and renderPie so another tool can draw the same pie", () => {
    const o = resolveOpts({ type: "pie", width: 420, height: 320, legend: true });
    const svg = renderPie(DATA, DATA.series, o);
    expect(svg).toContain("<svg");
    expect(svg.match(/<path /g)).toHaveLength(3);
    expect(svg).toContain('data-label="Usable"');
    expect(svg).toContain('data-label="Parity"');
    expect(svg).toContain('data-label="Spare"');
    expect(svg).toContain("data-chart-ink");
  });

  it("draws a wedge for a pie and a ring segment for a donut", () => {
    const wedge = slicePath(100, 100, 80, 0, 0, Math.PI / 2);
    const ring = slicePath(100, 100, 80, 40, 0, Math.PI / 2);
    expect(wedge.startsWith("M100,100")).toBe(true);
    expect(wedge).toContain("A80,80");
    expect(ring.startsWith("M180,100")).toBe(true);
    expect(ring).toContain("A40,40");
  });

  it("matches what renderChart produces for the same pie", () => {
    const o = resolveOpts({ type: "pie", width: 420, height: 320 });
    expect(renderPie(DATA, DATA.series, o)).toBe(
      renderChart(DATA, { type: "pie", width: 420, height: 320 }),
    );
  });
});
