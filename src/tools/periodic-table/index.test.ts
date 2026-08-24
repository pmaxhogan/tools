import { describe, expect, it } from "vitest";
import { ELEMENTS } from "../_generated/elements";
import { ToolError } from "../types";
import {
  CATEGORIES,
  PALETTES,
  PALETTE_IDS,
  TRENDS,
  describeElement,
  elementAt,
  elementByAtomicNumber,
  elementBySymbol,
  findElement,
  layoutFor,
  layoutStandard,
  layoutWide,
  normalizeTrend,
  paletteColor,
  pubchemUrl,
  run,
  trendColor,
  trendRange,
  trendValue,
  wikipediaUrl,
  type ElementCell,
} from "./index";

const elements = (cells: { kind: string }[]) =>
  cells.filter((c) => c.kind === "element") as ElementCell[];
const at = (layout: { cells: { kind: string }[] }, z: number) =>
  elements(layout.cells).find((c) => c.element.atomicNumber === z)!;

describe("lookup helpers", () => {
  it("finds by symbol, name and atomic number", () => {
    expect(elementBySymbol("Fe")!.name).toBe("Iron");
    expect(elementBySymbol("fe")!.atomicNumber).toBe(26);
    expect(elementByAtomicNumber(26)!.symbol).toBe("Fe");
    expect(findElement("iron")!.symbol).toBe("Fe");
    expect(findElement("26")!.symbol).toBe("Fe");
    expect(findElement(" og ")!.name).toBe("Oganesson");
  });

  it("returns undefined for nonsense", () => {
    expect(elementBySymbol("Zz")).toBeUndefined();
    expect(findElement("")).toBeUndefined();
    expect(findElement("119")).toBeUndefined();
    expect(elementByAtomicNumber(0)).toBeUndefined();
  });

  it("answers elementAt from the dataset period and group", () => {
    expect(elementAt(1, 1)!.symbol).toBe("H");
    expect(elementAt(1, 18)!.symbol).toBe("He");
    expect(elementAt(4, 8)!.symbol).toBe("Fe");
    expect(elementAt(2, 3)).toBeUndefined();
    // The f block carries no group in this dataset, in either layout.
    expect(elementAt(6, 3)).toBeUndefined();
    expect(elementAt(7, 3)).toBeUndefined();
  });

  it("lists the PubChem categories", () => {
    expect(CATEGORIES).toContain("Noble gas");
    expect(CATEGORIES).toContain("Lanthanide");
    expect(new Set(CATEGORIES).size).toBe(CATEGORIES.length);
  });
});

describe("layoutStandard", () => {
  const layout = layoutStandard();

  it("is an 18 column grid holding all 118 elements", () => {
    expect(layout.mode).toBe("standard");
    expect(layout.columns).toBe(18);
    expect(layout.rows).toBe(10);
    expect(elements(layout.cells).length).toBe(118);
  });

  it("keeps every cell inside the grid", () => {
    for (const c of layout.cells) {
      expect(c.x).toBeGreaterThanOrEqual(1);
      expect(c.x).toBeLessThanOrEqual(18);
      expect(c.y).toBeGreaterThanOrEqual(1);
      expect(c.y).toBeLessThanOrEqual(10);
    }
  });

  it("never puts two cells in the same slot", () => {
    const seen = new Set(layout.cells.map((c) => `${c.x},${c.y}`));
    expect(seen.size).toBe(layout.cells.length);
  });

  it("places the corners and a middle element where the printed table does", () => {
    expect(at(layout, 1)).toMatchObject({ x: 1, y: 1 });
    expect(at(layout, 2)).toMatchObject({ x: 18, y: 1 });
    expect(at(layout, 26)).toMatchObject({ x: 8, y: 4 });
    expect(at(layout, 118)).toMatchObject({ x: 18, y: 7 });
  });

  it("drops the f block into rows 9 and 10, columns 3 to 17", () => {
    expect(at(layout, 57)).toMatchObject({ x: 3, y: 9 });
    expect(at(layout, 71)).toMatchObject({ x: 17, y: 9 });
    expect(at(layout, 89)).toMatchObject({ x: 3, y: 10 });
    expect(at(layout, 103)).toMatchObject({ x: 17, y: 10 });
    expect(elements(layout.cells).filter((c) => c.y === 9).length).toBe(15);
    expect(elements(layout.cells).filter((c) => c.y === 10).length).toBe(15);
    expect(elements(layout.cells).filter((c) => c.y === 8).length).toBe(0);
  });

  it("leaves the lanthanide and actinide markers in group 3", () => {
    const markers = layout.cells.filter((c) => c.kind === "marker");
    expect(markers).toHaveLength(2);
    expect(markers).toContainEqual({
      kind: "marker",
      label: "57-71",
      series: "lanthanide",
      x: 3,
      y: 6,
    });
    expect(markers).toContainEqual({
      kind: "marker",
      label: "89-103",
      series: "actinide",
      x: 3,
      y: 7,
    });
  });
});

describe("layoutWide", () => {
  const layout = layoutWide();

  it("is a 32 column grid holding all 118 elements and no markers", () => {
    expect(layout.mode).toBe("wide");
    expect(layout.columns).toBe(32);
    expect(layout.rows).toBe(7);
    expect(layout.cells.length).toBe(118);
    expect(elements(layout.cells).length).toBe(118);
    expect(layout.cells.some((c) => c.kind === "marker")).toBe(false);
  });

  it("keeps every cell inside the grid and never collides", () => {
    for (const c of layout.cells) {
      expect(c.x).toBeGreaterThanOrEqual(1);
      expect(c.x).toBeLessThanOrEqual(32);
      expect(c.y).toBeGreaterThanOrEqual(1);
      expect(c.y).toBeLessThanOrEqual(7);
    }
    const seen = new Set(layout.cells.map((c) => `${c.x},${c.y}`));
    expect(seen.size).toBe(118);
  });

  it("pushes groups 3 to 18 right by 14 columns", () => {
    expect(at(layout, 1)).toMatchObject({ x: 1, y: 1 });
    expect(at(layout, 2)).toMatchObject({ x: 32, y: 1 });
    expect(at(layout, 21)).toMatchObject({ x: 17, y: 4 });
    expect(at(layout, 26)).toMatchObject({ x: 22, y: 4 });
    expect(at(layout, 118)).toMatchObject({ x: 32, y: 7 });
  });

  it("splices the f block inline with element 71 and 103 in the group 3 column", () => {
    expect(at(layout, 57)).toMatchObject({ x: 3, y: 6 });
    expect(at(layout, 70)).toMatchObject({ x: 16, y: 6 });
    expect(at(layout, 71)).toMatchObject({ x: 17, y: 6 });
    expect(at(layout, 72)).toMatchObject({ x: 18, y: 6 });
    expect(at(layout, 89)).toMatchObject({ x: 3, y: 7 });
    expect(at(layout, 103)).toMatchObject({ x: 17, y: 7 });
    expect(at(layout, 104)).toMatchObject({ x: 18, y: 7 });
  });

  it("keeps atomic number increasing left to right within a row", () => {
    for (let period = 1; period <= 7; period++) {
      const row = elements(layout.cells)
        .filter((c) => c.y === period)
        .sort((a, b) => a.x - b.x)
        .map((c) => c.element.atomicNumber);
      expect(row).toEqual([...row].sort((a, b) => a - b));
    }
  });

  it("layoutFor picks the requested mode and defaults to standard", () => {
    expect(layoutFor("wide").columns).toBe(32);
    expect(layoutFor("standard").columns).toBe(18);
    expect(layoutFor("nonsense").columns).toBe(18);
  });
});

describe("trends", () => {
  it("normalizes every published value into 0..1", () => {
    for (const trend of TRENDS) {
      let sawZero = false;
      let sawOne = false;
      for (const el of ELEMENTS) {
        const t = normalizeTrend(el, trend.id);
        if (t === undefined) {
          expect(trendValue(el, trend.id)).toBeUndefined();
          continue;
        }
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThanOrEqual(1);
        if (t === 0) sawZero = true;
        if (t === 1) sawOne = true;
      }
      expect(sawZero).toBe(true);
      expect(sawOne).toBe(true);
    }
  });

  it("reports the observed range and how many elements have a value", () => {
    const en = trendRange("electronegativity");
    expect(en.min).toBeCloseTo(0.7, 6);
    expect(en.max).toBeCloseTo(3.98, 6);
    expect(en.count).toBe(95);
    expect(trendRange("density").count).toBe(96);
    expect(normalizeTrend(elementBySymbol("F")!, "electronegativity")).toBe(1);
    expect(normalizeTrend(elementBySymbol("Fr")!, "electronegativity")).toBe(0);
  });

  it("returns undefined for an element with no published value", () => {
    const og = elementBySymbol("Og")!;
    expect(trendValue(og, "electronegativity")).toBeUndefined();
    expect(normalizeTrend(og, "electronegativity")).toBeUndefined();
    expect(trendColor(og, "electronegativity")).toBeUndefined();
  });

  it("uses a log scale for density so the light gases stay distinguishable", () => {
    const hydrogen = normalizeTrend(elementBySymbol("H")!, "density")!;
    const osmium = normalizeTrend(elementBySymbol("Os")!, "density")!;
    const iron = normalizeTrend(elementBySymbol("Fe")!, "density")!;
    expect(hydrogen).toBe(0);
    expect(osmium).toBe(1);
    // A linear ramp would put iron at 7.87/22.57 = 0.35; log lifts it well past that.
    expect(iron).toBeGreaterThan(0.9);
    expect(TRENDS.find((t) => t.id === "density")!.scale).toBe("log");
  });

  it("paints a color for every palette", () => {
    for (const palette of PALETTE_IDS) {
      const paint = trendColor(elementBySymbol("O")!, "electronegativity", palette)!;
      expect(paint.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(paint.t).toBeGreaterThan(0);
      expect(paint.value).toBeCloseTo(3.44, 6);
    }
  });

  it("samples palettes at the endpoints and clamps out of range input", () => {
    expect(paletteColor(0, "viridis")).toBe(PALETTES.viridis[0]);
    expect(paletteColor(1, "viridis")).toBe(PALETTES.viridis[PALETTES.viridis.length - 1]);
    expect(paletteColor(-5, "grayscale")).toBe(PALETTES.grayscale[0]);
    expect(paletteColor(9, "grayscale")).toBe(PALETTES.grayscale[1]);
    expect(paletteColor(Number.NaN, "plasma")).toBe(PALETTES.plasma[0]);
    expect(paletteColor(0.5, "blue-red")).toBe(PALETTES["blue-red"][1]);
  });
});

describe("describeElement", () => {
  it("summarizes an element with links", () => {
    const out = describeElement(elementBySymbol("Fe")!);
    expect(out["Name"]).toBe("Iron");
    expect(out["Symbol"]).toBe("Fe");
    expect(out["Atomic number"]).toBe("26");
    expect(out["Period"]).toBe("4");
    expect(out["Group"]).toBe("8");
    expect(out["Category"]).toBe("Transition metal");
    expect(out["Melting point"]).toContain(" K (");
    expect(out["Wikipedia"]).toBe("https://en.wikipedia.org/wiki/Iron");
    expect(out["PubChem"]).toBe("https://pubchem.ncbi.nlm.nih.gov/element/26");
    expect(out["Source"]).toContain("PubChem");
  });

  it("labels the f block instead of inventing a group", () => {
    expect(describeElement(elementByAtomicNumber(57)!)["Group"]).toBe("f block (lanthanide)");
    expect(describeElement(elementByAtomicNumber(92)!)["Group"]).toBe("f block (actinide)");
  });

  it("omits fields PubChem does not publish", () => {
    const out = describeElement(elementBySymbol("Og")!);
    expect(out["Electronegativity"]).toBeUndefined();
    expect(out["Density"]).toBeUndefined();
    expect(out["Name"]).toBe("Oganesson");
  });

  it("builds article links with underscores", () => {
    const el = elementBySymbol("He")!;
    expect(wikipediaUrl(el)).toBe("https://en.wikipedia.org/wiki/Helium");
    expect(pubchemUrl(el)).toBe("https://pubchem.ncbi.nlm.nih.gov/element/2");
  });
});

describe("run", () => {
  it("describes the requested element", () => {
    const out = run(undefined, { symbol: "Fe" });
    expect(out["Name"]).toBe("Iron");
    expect(out["Position (standard layout)"]).toBe("column 8, row 4");
  });

  it("adds a trend line when a trend is picked", () => {
    const out = run(undefined, { symbol: "O", trend: "electronegativity", palette: "plasma" });
    expect(out["Trend: Electronegativity"]).toContain("3.44 Pauling");
    expect(out["Trend: Electronegativity"]).toMatch(/#[0-9a-f]{6}/);
  });

  it("says so when the element has no value for the trend", () => {
    const out = run(undefined, { symbol: "Og", trend: "density" });
    expect(out["Trend: Density"]).toContain("no published value");
  });

  it("honors the layout option", () => {
    expect(run(undefined, { symbol: "Lu", layout: "wide" })["Position (wide layout)"]).toBe(
      "column 17, row 6",
    );
    expect(run(undefined, { symbol: "Lu", layout: "standard" })["Position (standard layout)"]).toBe(
      "column 17, row 9",
    );
  });

  it("ignores an unknown trend or palette instead of failing", () => {
    const out = run(undefined, { symbol: "Fe", trend: "nope", palette: "nope" });
    expect(Object.keys(out).some((k) => k.startsWith("Trend:"))).toBe(false);
    expect(
      run(undefined, { symbol: "Fe", trend: "density", palette: "nope" })["Trend: Density"],
    ).toMatch(/#[0-9a-f]{6}/);
  });

  it("throws for a missing or unknown element", () => {
    expect(() => run(undefined, {})).toThrow(ToolError);
    expect(() => run(undefined, { symbol: "" })).toThrow(/No element chosen/);
    try {
      run(undefined, { symbol: "Zz" });
      throw new Error("expected a ToolError");
    } catch (err) {
      expect((err as ToolError).code).toBe("unknown-element");
      expect((err as ToolError).fix).toContain("atomic number");
    }
  });

  it("is the default export", async () => {
    const mod = await import("./index");
    expect(mod.default.run(undefined, { symbol: "1" })["Name"]).toBe("Hydrogen");
  });
});
