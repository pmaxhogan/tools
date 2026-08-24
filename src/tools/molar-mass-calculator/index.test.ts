import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  hillFormula,
  molarMass,
  normalizeFormula,
  parseFormula,
  percentComposition,
  run,
} from "./index";

describe("parseFormula", () => {
  it("counts a simple formula", () => {
    const p = parseFormula("H2O");
    expect(p.counts).toEqual({ H: 2, O: 1 });
    expect(p.totalAtoms).toBe(3);
    expect(p.formula).toBe("H2O");
  });

  it("keeps two letter symbols apart from two one letter symbols", () => {
    expect(parseFormula("CO").counts).toEqual({ C: 1, O: 1 });
    expect(parseFormula("Co").counts).toEqual({ Co: 1 });
    expect(parseFormula("NaCl").counts).toEqual({ Na: 1, Cl: 1 });
  });

  it("expands parentheses", () => {
    expect(parseFormula("Ca(OH)2").counts).toEqual({ Ca: 1, O: 2, H: 2 });
  });

  it("expands nested parentheses and brackets", () => {
    expect(parseFormula("[Cu(NH3)4]SO4").counts).toEqual({ Cu: 1, N: 4, H: 12, S: 1, O: 4 });
    expect(parseFormula("K4[Fe(CN)6]").counts).toEqual({ K: 4, Fe: 1, C: 6, N: 6 });
    expect(parseFormula("Al2{(OH)2}3").counts).toEqual({ Al: 2, O: 6, H: 6 });
  });

  it("adds hydrate segments written with a dot or a middle dot", () => {
    const dot = parseFormula("CuSO4.5H2O");
    const middle = parseFormula("CuSO4·5H2O");
    expect(dot.counts).toEqual({ Cu: 1, S: 1, O: 9, H: 10 });
    expect(middle.counts).toEqual(dot.counts);
    expect(middle.formula).toBe("CuSO4.5H2O");
  });

  it("applies a leading coefficient to the whole segment", () => {
    expect(parseFormula("2H2O").counts).toEqual({ H: 4, O: 2 });
    expect(parseFormula("Na2CO3.10H2O").counts).toEqual({ Na: 2, C: 1, O: 13, H: 20 });
  });

  it("merges repeated elements across a formula", () => {
    expect(parseFormula("CH3COOH").counts).toEqual({ C: 2, H: 4, O: 2 });
  });

  it("strips whitespace and treats a space separated hydrate as a hydrate", () => {
    expect(parseFormula(" Ca ( OH ) 2 ").counts).toEqual({ Ca: 1, O: 2, H: 2 });
  });
});

describe("normalizeFormula", () => {
  it("folds unicode subscripts into counts", () => {
    expect(normalizeFormula("H₂O").formula).toBe("H2O");
    expect(parseFormula("C₆H₁₂O₆").counts).toEqual({ C: 6, H: 12, O: 6 });
  });

  it("lifts a caret charge out of the formula", () => {
    const p = parseFormula("SO4^2-");
    expect(p.formula).toBe("SO4");
    expect(p.charge).toBe("2-");
    expect(p.counts).toEqual({ S: 1, O: 4 });
  });

  it("lifts a trailing charge and a bracketed complex charge", () => {
    expect(parseFormula("Fe3+").charge).toBe("3+");
    expect(parseFormula("Fe3+").counts).toEqual({ Fe: 1 });
    const complex = parseFormula("[Cu(NH3)4]2+");
    expect(complex.charge).toBe("2+");
    expect(complex.counts).toEqual({ Cu: 1, N: 4, H: 12 });
  });

  it("lifts a unicode superscript charge", () => {
    const p = parseFormula("SO₄²⁻");
    expect(p.formula).toBe("SO4");
    expect(p.charge).toBe("2-");
  });

  it("drops lowercase state labels but keeps an uppercase group", () => {
    expect(parseFormula("H2O(l)").counts).toEqual({ H: 2, O: 1 });
    expect(parseFormula("NaCl(aq)").counts).toEqual({ Na: 1, Cl: 1 });
    expect(parseFormula("Fe(S)2").counts).toEqual({ Fe: 1, S: 2 });
  });

  it("normalizes a single sign charge to a bare sign", () => {
    expect(parseFormula("Na+").charge).toBe("+");
    expect(parseFormula("Cl-").charge).toBe("-");
  });
});

describe("molarMass", () => {
  it("matches published values for the reference compounds", () => {
    expect(molarMass("H2O")).toBeCloseTo(18.015, 3);
    expect(molarMass("Ca(OH)2")).toBeCloseTo(74.09, 2);
    expect(molarMass("C6H12O6")).toBeCloseTo(180.156, 3);
  });

  it("weighs a hydrate including its water", () => {
    const mass = molarMass("CuSO4.5H2O");
    // PubChem publishes rounded weights (Cu 63.55, S 32.07), which land this
    // 0.006 above the commonly published 249.685 for the pentahydrate.
    expect(mass).toBeCloseTo(249.691, 3);
    expect(Math.abs(mass - 249.685)).toBeLessThan(0.02);
    // The anhydrous salt plus five waters has to equal the hydrate.
    expect(molarMass("CuSO4") + 5 * molarMass("H2O")).toBeCloseTo(mass, 6);
  });

  it("accepts parsed counts as well as a string", () => {
    expect(molarMass({ H: 2, O: 1 })).toBeCloseTo(18.015, 3);
  });

  it("ignores the charge when weighing an ion", () => {
    expect(molarMass("SO4^2-")).toBeCloseTo(molarMass("SO4"), 9);
  });
});

describe("percentComposition", () => {
  it("sorts by share, descending, and sums to 100", () => {
    const shares = percentComposition(parseFormula("H2O").counts);
    expect(shares.map((s) => s.symbol)).toEqual(["O", "H"]);
    expect(shares[0]!.percent).toBeCloseTo(88.81, 1);
    expect(shares[1]!.percent).toBeCloseTo(11.19, 1);
    expect(shares.reduce((a, s) => a + s.percent, 0)).toBeCloseTo(100, 6);
  });

  it("names each element and reports its atom count", () => {
    const shares = percentComposition(parseFormula("CuSO4.5H2O").counts);
    const oxygen = shares.find((s) => s.symbol === "O")!;
    expect(oxygen.name).toBe("Oxygen");
    expect(oxygen.atoms).toBe(9);
    expect(shares.map((s) => s.symbol)).toEqual(["O", "Cu", "S", "H"]);
  });
});

describe("hillFormula", () => {
  it("puts carbon then hydrogen first for organic compounds", () => {
    expect(hillFormula(parseFormula("CH3COOH").counts)).toBe("C2H4O2");
    expect(hillFormula(parseFormula("C6H12O6").counts)).toBe("C6H12O6");
  });

  it("sorts alphabetically when there is no carbon", () => {
    expect(hillFormula(parseFormula("CuSO4.5H2O").counts)).toBe("CuH10O9S");
    expect(hillFormula(parseFormula("H2O").counts)).toBe("H2O");
  });
});

describe("run", () => {
  it("returns the full record for a hydrate", () => {
    const out = run("CuSO4.5H2O", { decimals: 3 });
    expect(out["Formula"]).toBe("CuSO4.5H2O");
    expect(out["Hill formula"]).toBe("CuH10O9S");
    expect(out["Molar mass"]).toBe("249.691 g/mol");
    expect(out["Total atoms"]).toBe("21");
    expect(out["Atom counts"]).toBe("Cu 1, H 10, O 9, S 1");
    expect(out["Percent composition"]!.startsWith("O ")).toBe(true);
    expect(out["Cu (Copper)"]).toContain("1 atom,");
    expect(out["H (Hydrogen)"]).toContain("10 atoms,");
  });

  it("honors the decimals option and defaults to three", () => {
    expect(run("H2O", { decimals: 1 })["Molar mass"]).toBe("18.0 g/mol");
    expect(run("H2O", {})["Molar mass"]).toBe("18.015 g/mol");
    expect(run("H2O")["Molar mass"]).toBe("18.015 g/mol");
    expect(run("H2O", { decimals: 99 })["Molar mass"]).toBe("18.015000 g/mol");
  });

  it("reports a stripped charge without changing the mass", () => {
    const out = run("SO4^2-");
    expect(out["Charge"]).toContain("2-");
    expect(out["Formula"]).toBe("SO4");
    expect(run("SO4")["Charge"]).toBeUndefined();
  });

  it("is the default export", async () => {
    const mod = await import("./index");
    expect(mod.default.run("H2O", {})["Molar mass"]).toBe("18.015 g/mol");
  });
});

describe("errors", () => {
  const codeOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      return (err as ToolError).code;
    }
    throw new Error("expected a ToolError");
  };

  it("rejects empty input", () => {
    expect(codeOf(() => run(""))).toBe("empty-input");
    expect(codeOf(() => run("   "))).toBe("empty-input");
    expect(codeOf(() => run("2+"))).toBe("empty-input");
  });

  it("rejects an unknown element with a capitalization hint", () => {
    expect(codeOf(() => parseFormula("Xy2O"))).toBe("unknown-element");
    expect(codeOf(() => parseFormula("Q"))).toBe("unknown-element");
    try {
      parseFormula("nacl");
    } catch (err) {
      expect((err as ToolError).code).toBe("unexpected-character");
    }
  });

  it("explains that isotope shorthand is unsupported", () => {
    try {
      parseFormula("D2O");
      throw new Error("expected a ToolError");
    } catch (err) {
      expect((err as ToolError).code).toBe("unknown-element");
      expect((err as ToolError).fix).toContain("Isotope");
    }
  });

  it("rejects unbalanced and mismatched brackets", () => {
    expect(codeOf(() => parseFormula("Ca(OH2"))).toBe("unbalanced-parentheses");
    expect(codeOf(() => parseFormula("CaOH)2"))).toBe("unbalanced-parentheses");
    expect(codeOf(() => parseFormula("Ca(OH]2"))).toBe("unbalanced-parentheses");
  });

  it("rejects an empty group", () => {
    expect(codeOf(() => parseFormula("Ca()2"))).toBe("empty-group");
  });

  it("rejects a zero count and an oversized one", () => {
    expect(codeOf(() => parseFormula("H0O"))).toBe("invalid-count");
    expect(codeOf(() => parseFormula("0H2O"))).toBe("invalid-count");
    expect(codeOf(() => parseFormula("H99999999"))).toBe("count-too-large");
    expect(codeOf(() => parseFormula("99999999H2O"))).toBe("count-too-large");
    expect(codeOf(() => parseFormula("(H1000)9999"))).toBe("count-too-large");
  });

  it("rejects a stray character and a misplaced dot", () => {
    expect(codeOf(() => parseFormula("H2O!"))).toBe("unexpected-character");
    expect(codeOf(() => parseFormula("Ca(O.H)2"))).toBe("misplaced-separator");
  });
});
