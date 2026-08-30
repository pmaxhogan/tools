import { describe, expect, it } from "vitest";
import { molarMass, parseFields, parseFormula, run, solvePrep } from "./index";
import { ToolError } from "../types";

/** Molar masses from the PubChem snapshot, so the tests move with the data. */
const M_NACL = 22.9897693 + 35.45;
const M_GLUCOSE = 6 * 12.011 + 12 * 1.008 + 6 * 15.999;

describe("the copied formula parser", () => {
  it("still reads formulas and hydrates", () => {
    expect(parseFormula("CuSO4.5H2O").counts).toEqual({ Cu: 1, S: 1, O: 9, H: 10 });
    expect(molarMass("NaCl")).toBeCloseTo(M_NACL, 9);
  });
});

describe("parseFields", () => {
  it("takes a leading bare formula", () => {
    const f = parseFields("NaCl, C=0.5 M, V=250 mL");
    expect(f.formula).toBe("NaCl");
    expect(f.concentration).toBe(0.5);
    expect(f.volume).toBeCloseTo(0.25, 12);
  });

  it("takes a named formula too", () => {
    expect(parseFields("formula=NaCl, C=1 M, V=1 L").formula).toBe("NaCl");
  });

  it("reads a molar mass override, a density and a purity", () => {
    const f = parseFields("molarMass=58.44, mass=5 g, V=100 mL, density=1.02 g/mL, purity=98%");
    expect(f.molarMass).toBe(58.44);
    expect(f.mass).toBe(5);
    expect(f.density).toBeCloseTo(1.02, 12);
    expect(f.purity).toBeCloseTo(0.98, 12);
  });

  it("reads concentrations in submultiples", () => {
    expect(parseFields("NaCl, C=50 mM, V=1 L").concentration).toBeCloseTo(0.05, 12);
  });

  it("rejects an empty input", () => {
    expect(() => parseFields("")).toThrow(/No solution to prepare/);
  });

  it("rejects an unknown field", () => {
    expect(() => parseFields("NaCl, banana=3")).toThrow(/not a value this tool knows/);
  });

  it("rejects an unknown unit", () => {
    expect(() => parseFields("NaCl, V=1 bucket")).toThrow(/not a volume unit/);
    expect(() => parseFields("NaCl, C=1 blorp")).toThrow(/not a concentration unit/);
  });

  it("rejects an impossible purity", () => {
    expect(() => parseFields("NaCl, purity=0%")).toThrow(/greater than zero/);
  });
});

describe("solvePrep", () => {
  it("works out the mass to weigh", () => {
    const r = solvePrep(parseFields("NaCl, C=0.5 M, V=250 mL"));
    expect(r.solvedFor).toBe("mass");
    expect(r.molarMass).toBeCloseTo(M_NACL, 9);
    expect(r.moles).toBeCloseTo(0.125, 12);
    expect(r.mass).toBeCloseTo(0.125 * M_NACL, 9);
  });

  it("works out the concentration from a mass", () => {
    const r = solvePrep(parseFields("C6H12O6, mass=18 g, V=100 mL"));
    expect(r.solvedFor).toBe("concentration");
    expect(r.concentration).toBeCloseTo(18 / M_GLUCOSE / 0.1, 9);
  });

  it("works out the volume from a mass and a target", () => {
    const r = solvePrep(parseFields("NaCl, mass=5.844 g, C=1 M"));
    expect(r.solvedFor).toBe("volume");
    expect(r.volume).toBeCloseTo(5.844 / M_NACL, 9);
  });

  it("prefers an explicit molar mass over the formula", () => {
    const r = solvePrep(parseFields("NaCl, molarMass=58.44, C=1 M, V=1 L"));
    expect(r.molarMass).toBe(58.44);
    expect(r.molarMassSource).toBe("override");
  });

  it("rejects an input with no compound", () => {
    expect(() => solvePrep(parseFields("C=1 M, V=1 L"))).toThrow(/what the compound weighs/);
  });

  it("rejects fewer than two of the three quantities", () => {
    expect(() => solvePrep(parseFields("NaCl, C=1 M"))).toThrow(/Two of concentration/);
  });

  it("rejects a bad formula through the parser", () => {
    expect(() => solvePrep(parseFields("NaXq, C=1 M, V=1 L"))).toThrow(ToolError);
  });

  it("rejects a zero volume when solving for concentration", () => {
    expect(() => solvePrep(parseFields("NaCl, mass=1 g, V=0 mL"))).toThrow(/no concentration/);
  });
});

describe("run", () => {
  it("prints the recipe and the derived concentrations", () => {
    const out = run("NaCl, C=0.5 M, V=250 mL", { decimals: 4 });
    expect(out["Compound"]).toBe("NaCl");
    expect(out["Mass of solute"]).toContain((0.125 * M_NACL).toFixed(4));
    expect(out["Normality"]).toContain("0.5000 N");
    expect(out["Step 1"]).toContain("Weigh");
    expect(out["Step 3"]).toContain("250.0000 mL");
    expect(out["Safety"]).toContain("add the acid to the water");
  });

  it("scales the weighed mass by the assay purity", () => {
    const out = run("NaCl, C=1 M, V=1 L, purity=98%", { decimals: 4 });
    expect(out["Mass to weigh out"]).toContain((M_NACL / 0.98).toFixed(4));
  });

  it("uses the equivalents option for normality", () => {
    const out = run("H2SO4, C=1 M, V=1 L", { equivalents: 2, decimals: 2 });
    expect(out["Normality"]).toBe("2.00 N at 2 equivalents per mole");
  });

  it("computes molality once a density is given", () => {
    const out = run("NaCl, C=1 M, V=1 L, density=1.04 g/mL", { decimals: 4 });
    expect(out["Solution mass"]).toContain("1040.0000 g");
    const solvent = 1040 - M_NACL;
    expect(out["Molality"]).toBe(`${(1 / (solvent / 1000)).toFixed(4)} mol/kg`);
  });

  it("says why molality is missing without a density", () => {
    const out = run("NaCl, C=1 M, V=1 L");
    expect(out["Molality"]).toContain("needs the density");
  });

  it("reports percent and parts per million", () => {
    const out = run("NaCl, mass=10 g, V=1 L", { decimals: 2 });
    expect(out["Percent weight in volume"]).toBe("1.00% w/v");
    expect(out["Parts per million"]).toBe("10000.00 ppm (mg per liter)");
  });
});
