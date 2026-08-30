import { describe, expect, it } from "vitest";
import {
  atomicWeight,
  empiricalFormula,
  looksLikeFormula,
  parseComposition,
  run,
} from "./index";
import { ToolError } from "../types";

const M_C = 12.011;
const M_H = 1.008;
const M_O = 15.999;

describe("parseComposition", () => {
  it("reads percentages", () => {
    const parsed = parseComposition("C: 40.0%, H: 6.7%, O: 53.3%");
    expect(parsed.entries).toHaveLength(3);
    expect(parsed.entries[0]).toMatchObject({ symbol: "C", kind: "percent", grams: 40 });
    expect(parsed.entries[0]!.moles).toBeCloseTo(40 / M_C, 10);
  });

  it("reads masses", () => {
    const parsed = parseComposition("C: 1.2 g\nH: 0.2 g\nO: 1.6 g");
    expect(parsed.entries[0]).toMatchObject({ kind: "mass", grams: 1.2 });
  });

  it("reads a molar mass line", () => {
    expect(parseComposition("C: 40%, H: 6.7%, O: 53.3%, molarMass: 180.16").molarMass).toBe(180.16);
  });

  it("treats a bare number as a percentage", () => {
    expect(parseComposition("C 40, H 6.7, O 53.3").entries[0]!.kind).toBe("percent");
  });

  it("rejects an empty input", () => {
    expect(() => parseComposition("")).toThrow(/No composition/);
  });

  it("rejects an unknown element", () => {
    expect(() => parseComposition("Xq: 40%")).toThrow(ToolError);
  });

  it("rejects a duplicate element", () => {
    expect(() => parseComposition("C: 40%, C: 20%")).toThrow(/more than once/);
  });

  it("rejects an unknown unit", () => {
    expect(() => parseComposition("C: 40 buckets")).toThrow(/not a unit/);
  });

  it("rejects a negative share", () => {
    expect(() => parseComposition("C: -40%")).toThrow(/negative/);
  });

  it("rejects an all zero composition", () => {
    expect(() => parseComposition("C: 0%, H: 0%")).toThrow(/Every share is zero/);
  });
});

describe("atomicWeight", () => {
  it("matches the table", () => {
    expect(atomicWeight("C")).toBe(M_C);
    expect(atomicWeight("O")).toBe(M_O);
  });

  it("rejects an unknown symbol", () => {
    expect(() => atomicWeight("Xq")).toThrow(ToolError);
  });
});

describe("empiricalFormula", () => {
  it("finds CH2O from the glucose composition", () => {
    const r = empiricalFormula(parseComposition("C: 40.0%, H: 6.7%, O: 53.3%"));
    expect(r.empiricalFormula).toBe("CH2O");
    expect(r.multiplier).toBe(1);
    expect(r.empiricalMass).toBeCloseTo(M_C + 2 * M_H + M_O, 9);
  });

  it("scales a fractional ratio to whole numbers", () => {
    const r = empiricalFormula(parseComposition("C: 92.3%, H: 7.7%"));
    expect(r.empiricalFormula).toBe("CH");
  });

  it("uses a multiplier of two when the ratio lands on a half", () => {
    // Phosphorus pentoxide: a 1 to 2.5 mole ratio that only clears at n = 2.
    const r = empiricalFormula(parseComposition("P: 43.64%, O: 56.36%"));
    expect(r.multiplier).toBe(2);
    expect(r.empiricalFormula).toBe("O5P2");
  });

  it("keeps a whole ratio at a multiplier of one", () => {
    const r = empiricalFormula(parseComposition("C: 85.6%, H: 14.4%"));
    expect(r.empiricalFormula).toBe("CH2");
    expect(r.multiplier).toBe(1);
  });

  it("promotes the empirical formula to the molecular formula", () => {
    const r = empiricalFormula(
      parseComposition("C: 40.0%, H: 6.7%, O: 53.3%, molarMass: 180.16"),
    );
    expect(r.molecularMultiple).toBe(6);
    expect(r.molecularFormula).toBe("C6H12O6");
  });

  it("works from masses just as well", () => {
    const r = empiricalFormula(parseComposition("C: 1.2 g, H: 0.2 g, O: 1.6 g"));
    expect(r.empiricalFormula).toBe("CH2O");
  });

  it("records the percentage total", () => {
    expect(empiricalFormula(parseComposition("C: 40%, H: 6.7%, O: 53.3%")).percentTotal).toBe(100);
  });

  it("rejects a ratio that will not clear to whole numbers", () => {
    expect(() =>
      empiricalFormula(parseComposition("C: 51.3%, H: 48.7%"), 0.001),
    ).toThrow(/No multiplier/);
  });
});

describe("looksLikeFormula", () => {
  it("spots a formula", () => {
    expect(looksLikeFormula("C6H12O6")).toBe(true);
    expect(looksLikeFormula("Ca(OH)2")).toBe(true);
  });

  it("does not mistake a composition for a formula", () => {
    expect(looksLikeFormula("C: 40%, H: 6.7%")).toBe(false);
    expect(looksLikeFormula("C 40, H 6.7")).toBe(false);
    expect(looksLikeFormula("")).toBe(false);
  });
});

describe("run", () => {
  it("reports the empirical formula and the working", () => {
    const out = run("C: 40.0%, H: 6.7%, O: 53.3%", { decimals: 4 });
    expect(out["Empirical formula"]).toBe("CH2O");
    expect(out["Molecular formula"]).toContain("needs the compound's molar mass");
    expect(out["C"]).toContain("subscript 1");
    expect(out["H"]).toContain("subscript 2");
    expect(out["Percentages given"]).toBe("100.00%");
  });

  it("reports the molecular formula when a molar mass is given", () => {
    const out = run("C: 40.0%, H: 6.7%, O: 53.3%, molarMass: 180.16");
    expect(out["Molecular formula"]).toBe("C6H12O6");
    expect(out["Empirical units per molecule"]).toBe("6");
  });

  it("flags percentages that do not add to a hundred", () => {
    const out = run("C: 40.0%, H: 6.7%");
    expect(out["Percentage check"]).toContain("rather than 100%");
  });

  it("runs the reverse direction on a formula", () => {
    const out = run("C6H12O6");
    expect(out["Formula"]).toBe("C6H12O6");
    expect(out["Percent composition"]).toContain("C 40.00%");
    expect(out["O (Oxygen)"]).toContain("% by mass");
  });

  it("forces the reverse direction with the mode option", () => {
    expect(run("H2O", { mode: "percent" })["Molar mass"]).toContain("g/mol");
  });

  it("forces the forward direction with the mode option", () => {
    expect(() => run("C6H12O6", { mode: "composition" })).toThrow(ToolError);
  });
});
