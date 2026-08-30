import { describe, expect, it } from "vitest";
import {
  parseConcentration,
  parseFields,
  parseVolume,
  run,
  serialDilution,
  solveDilution,
} from "./index";
import { ToolError } from "../types";

describe("parsing", () => {
  it("reads concentrations in every family", () => {
    expect(parseConcentration("2 M", "C1")).toMatchObject({ canonical: 2, family: "molar" });
    expect(parseConcentration("500 mM", "C1").canonical).toBeCloseTo(0.5, 12);
    expect(parseConcentration("0.5 mg/mL", "C1")).toMatchObject({ canonical: 0.5, family: "mass" });
    expect(parseConcentration("70%", "C1").canonical).toBeCloseTo(700, 9);
    expect(parseConcentration("10X", "C1")).toMatchObject({ family: "fold", canonical: 10 });
    expect(parseConcentration("250 ppm", "C1").canonical).toBeCloseTo(0.25, 12);
  });

  it("keeps capitalization meaningful", () => {
    expect(parseConcentration("1 mM", "C1").canonical).toBeCloseTo(1e-3, 15);
    expect(parseConcentration("1 M", "C1").canonical).toBe(1);
  });

  it("reads volumes and defaults to millilitres", () => {
    expect(parseVolume("50 mL", "V1").liters).toBeCloseTo(0.05, 12);
    expect(parseVolume("2 L", "V1").liters).toBe(2);
    expect(parseVolume("100", "V1").liters).toBeCloseTo(0.1, 12);
  });

  it("rejects a concentration with no unit", () => {
    expect(() => parseConcentration("2", "C1")).toThrow(/has no unit/);
  });

  it("rejects unknown units", () => {
    expect(() => parseConcentration("2 blorps", "C1")).toThrow(/not a concentration unit/);
    expect(() => parseVolume("2 gallons", "V1")).toThrow(/not a volume unit/);
  });

  it("reads name=value pairs and a ratio factor", () => {
    const f = parseFields("C1=2 M, V2=100 mL, factor=1:10, steps=4");
    expect(f.c1?.canonical).toBe(2);
    expect(f.v2?.liters).toBeCloseTo(0.1, 12);
    expect(f.factor).toBe(10);
    expect(f.steps).toBe(4);
  });

  it("rejects an unknown field", () => {
    expect(() => parseFields("banana=3 M")).toThrow(/not a value this tool knows/);
  });

  it("rejects an empty input", () => {
    expect(() => parseFields("")).toThrow(/No values/);
  });

  it("rejects a factor of one or less", () => {
    expect(() => parseFields("factor=1")).toThrow(/greater than one/);
  });

  it("rejects a silly number of steps", () => {
    expect(() => parseFields("steps=100")).toThrow(/between 1 and 40/);
  });
});

describe("solveDilution", () => {
  it("solves for the stock volume", () => {
    const r = solveDilution(parseFields("C1=2 M, C2=0.1 M, V2=100 mL"));
    expect(r.solvedFor).toBe("V1");
    expect(r.v1.liters).toBeCloseTo(0.005, 12);
    expect(r.dilutionFactor).toBeCloseTo(20, 12);
  });

  it("solves for the final volume", () => {
    const r = solveDilution(parseFields("C1=2 M, V1=5 mL, C2=0.1 M"));
    expect(r.solvedFor).toBe("V2");
    expect(r.v2.liters).toBeCloseTo(0.1, 12);
  });

  it("solves for the stock concentration", () => {
    const r = solveDilution(parseFields("V1=5 mL, C2=0.1 M, V2=100 mL"));
    expect(r.solvedFor).toBe("C1");
    expect(r.c1.canonical).toBeCloseTo(2, 12);
  });

  it("solves for the final concentration", () => {
    const r = solveDilution(parseFields("C1=2 M, V1=5 mL, V2=100 mL"));
    expect(r.solvedFor).toBe("C2");
    expect(r.c2.canonical).toBeCloseTo(0.1, 12);
  });

  it("converts across unit scales inside one family", () => {
    const r = solveDilution(parseFields("C1=1 M, C2=50 mM, V2=1 L"));
    expect(r.v1.liters).toBeCloseTo(0.05, 12);
  });

  it("crosses from mass to molar when a molar mass is given", () => {
    const r = solveDilution(parseFields("C1=1 M, C2=5.844 mg/mL, V2=100 mL, molarMass=58.44"));
    expect(r.v1.liters).toBeCloseTo(0.01, 9);
  });

  it("refuses to cross families without a molar mass", () => {
    expect(() => solveDilution(parseFields("C1=1 M, C2=5 mg/mL, V2=100 mL"))).toThrow(
      /only convert through/,
    );
  });

  it("refuses to compare a fold with a molar concentration", () => {
    expect(() => solveDilution(parseFields("C1=10X, C2=1 M, V2=100 mL"))).toThrow(
      /cannot be compared/,
    );
  });

  it("rejects fewer than three values", () => {
    expect(() => solveDilution(parseFields("C1=2 M, C2=0.1 M"))).toThrow(/needs three of the four/);
  });

  it("rejects a stock concentration of zero", () => {
    expect(() => solveDilution(parseFields("C1=0 M, C2=0.1 M, V2=100 mL"))).toThrow(
      ToolError,
    );
  });
});

describe("serialDilution", () => {
  it("builds the tube plan", () => {
    const plan = serialDilution(parseFields("C1=1 M, factor=10, steps=3, volume=1 mL"));
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0]!.canonical).toBeCloseTo(0.1, 12);
    expect(plan.steps[2]!.canonical).toBeCloseTo(0.001, 12);
    expect(plan.steps[0]!.transfer).toBeCloseTo(1e-4, 15);
    expect(plan.steps[0]!.diluent).toBeCloseTo(9e-4, 15);
  });

  it("defaults to five steps in one millilitre", () => {
    const plan = serialDilution(parseFields("C1=1 M, factor=2"));
    expect(plan.steps).toHaveLength(5);
    expect(plan.tube.liters).toBeCloseTo(1e-3, 15);
  });

  it("rejects a series with no stock", () => {
    expect(() => serialDilution(parseFields("factor=10"))).toThrow(/starts from a stock/);
  });

  it("rejects a series with no factor", () => {
    expect(() => serialDilution(parseFields("C1=1 M"))).toThrow(/needs a dilution factor/);
  });
});

describe("run", () => {
  it("reports the preparation sentence and the safety note", () => {
    const out = run("C1=2 M, C2=0.1 M, V2=100 mL", { decimals: 2 });
    expect(out["Solved for"]).toBe("V1");
    expect(out["V1 (stock volume)"]).toBe("5.00 mL");
    expect(out["Solvent to add"]).toBe("95.00 mL (assuming the volumes add)");
    expect(out["How to prepare"]).toContain("Measure 5.00 mL of the 2.00 M stock");
    expect(out["Safety"]).toContain("add the acid to the water");
  });

  it("checks all four values when they are all given", () => {
    const out = run("C1=2 M, V1=5 mL, C2=0.1 M, V2=100 mL");
    expect(out["Consistency check"]).toContain("they agree");
  });

  it("flags four values that disagree", () => {
    const out = run("C1=2 M, V1=5 mL, C2=0.1 M, V2=50 mL");
    expect(out["Consistency check"]).toContain("disagree");
  });

  it("explains how percent is read", () => {
    const out = run("C1=70%, C2=10%, V2=100 mL");
    expect(out["Percent reading"]).toContain("1 gram in 100 millilitres");
  });

  it("prints the serial dilution table", () => {
    const out = run("C1=1 M, factor=10, steps=3, volume=1 mL", { mode: "serial", decimals: 4 });
    expect(out["Tube 1"]).toBe("0.1000 M (1 in 10.0000 of the stock)");
    expect(out["Tube 3"]).toBe("0.0010 M (1 in 1000.0000 of the stock)");
    expect(out["Final concentration"]).toBe("0.0010 M");
    expect(out["Safety"]).toContain("Educational reference");
  });
});
