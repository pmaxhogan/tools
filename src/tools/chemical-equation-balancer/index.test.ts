import { describe, expect, it } from "vitest";
import {
  balance,
  balanceEquation,
  classify,
  parseCompound,
  parseEquation,
  parseSpecies,
  readCharge,
  redoxHint,
  renderEquation,
  run,
  splitSide,
} from "./index";
import { ToolError } from "../types";

function balanced(equation: string): string {
  return run(equation)["Balanced equation"]!;
}

describe("parseCompound", () => {
  it("counts a simple formula", () => {
    expect(parseCompound("H2O")).toEqual({ H: 2, O: 1 });
  });

  it("expands nested groups", () => {
    expect(parseCompound("Ca(OH)2")).toEqual({ Ca: 1, O: 2, H: 2 });
    expect(parseCompound("[Cu(NH3)4]SO4")).toEqual({ Cu: 1, N: 4, H: 12, S: 1, O: 4 });
  });

  it("sums hydrate segments", () => {
    expect(parseCompound("CuSO4.5H2O")).toEqual({ Cu: 1, S: 1, O: 9, H: 10 });
  });

  it("rejects an unknown symbol", () => {
    expect(() => parseCompound("Xy2")).toThrow(ToolError);
  });

  it("rejects an unbalanced bracket", () => {
    expect(() => parseCompound("Ca(OH2")).toThrow(/never closed/);
  });

  it("rejects a zero subscript", () => {
    expect(() => parseCompound("H0O")).toThrow(/leaves nothing/);
  });
});

describe("splitSide", () => {
  it("splits on spaced plus signs", () => {
    expect(splitSide(" Fe + O2 ")).toEqual(["Fe", "O2"]);
  });

  it("splits on tight plus signs", () => {
    expect(splitSide("Fe+O2")).toEqual(["Fe", "O2"]);
  });

  it("keeps a trailing plus as a charge", () => {
    expect(splitSide("H+ + OH-")).toEqual(["H+", "OH-"]);
  });

  it("keeps a caret charge with its species", () => {
    expect(splitSide("Fe^3+ + Cl-")).toEqual(["Fe^3+", "Cl-"]);
  });
});

describe("parseSpecies", () => {
  it("reads a coefficient, a state and a charge", () => {
    const sp = parseSpecies("2SO4^2-(aq)", "left");
    expect(sp.given).toBe(2);
    expect(sp.state).toBe("aq");
    expect(sp.charge).toBe(-2);
    expect(sp.formula).toBe("SO4");
    expect(sp.counts).toEqual({ S: 1, O: 4 });
  });

  it("reads a trailing charge without a caret", () => {
    expect(parseSpecies("Fe3+", "left").charge).toBe(3);
    expect(parseSpecies("Cl-", "right").charge).toBe(-1);
  });

  it("keeps a hydroxide group rather than reading it as a state", () => {
    expect(parseSpecies("Ca(OH)2", "left").counts).toEqual({ Ca: 1, O: 2, H: 2 });
  });
});

describe("readCharge", () => {
  it("reads a caret charge literally", () => {
    expect(readCharge("SO4^2-")).toEqual({ formula: "SO4", charge: -2 });
  });

  it("treats a lone digit before a sign as a charge only on a single element", () => {
    expect(readCharge("Fe2+")).toEqual({ formula: "Fe", charge: 2 });
    expect(readCharge("MnO4-")).toEqual({ formula: "MnO4", charge: -1 });
    expect(readCharge("NH4+")).toEqual({ formula: "NH4", charge: 1 });
  });

  it("splits a two digit run into a subscript and a charge", () => {
    expect(readCharge("Cr2O72-")).toEqual({ formula: "Cr2O7", charge: -2 });
  });

  it("counts repeated signs", () => {
    expect(readCharge("Ca++")).toEqual({ formula: "Ca", charge: 2 });
  });

  it("leaves a neutral formula alone", () => {
    expect(readCharge("H2O")).toEqual({ formula: "H2O", charge: 0 });
  });
});

describe("balance", () => {
  it("balances the classic rust equation", () => {
    expect(balanced("Fe + O2 -> Fe2O3")).toBe("4 Fe + 3 O2 -> 2 Fe2O3");
  });

  it("balances propane combustion", () => {
    expect(balanced("C3H8 + O2 -> CO2 + H2O")).toBe("C3H8 + 5 O2 -> 3 CO2 + 4 H2O");
  });

  it("balances a double replacement with states", () => {
    expect(balanced("Pb(NO3)2(aq) + KI(aq) -> PbI2(s) + KNO3(aq)")).toBe(
      "Pb(NO3)2(aq) + 2 KI(aq) -> PbI2(s) + 2 KNO3(aq)",
    );
  });

  it("balances an ionic equation using the charge row", () => {
    expect(balanced("MnO4- + Fe2+ + H+ -> Mn2+ + Fe3+ + H2O")).toBe(
      "MnO4- + 5 Fe2+ + 8 H+ -> Mn2+ + 5 Fe3+ + 4 H2O",
    );
  });

  it("balances a hydrate", () => {
    expect(balanced("CuSO4.5H2O -> CuSO4 + H2O")).toBe("CuSO4.5H2O -> CuSO4 + 5 H2O");
  });

  it("accepts the unicode arrow, unicode subscripts and the middle dot", () => {
    expect(balanced("H₂ + O₂ → H₂O")).toBe("2 H2 + O2 -> 2 H2O");
  });

  it("accepts an equals sign as the arrow", () => {
    expect(balanced("N2 + H2 = NH3")).toBe("N2 + 3 H2 -> 2 NH3");
  });

  it("ignores coefficients that were already typed", () => {
    const out = run("2 H2 + O2 -> 2 H2O");
    expect(out["Balanced equation"]).toBe("2 H2 + O2 -> 2 H2O");
    expect(out["Coefficients you typed"]).toMatch(/already the smallest/);
  });

  it("reduces to the smallest whole numbers", () => {
    expect(balanced("4 H2 + 2 O2 -> 4 H2O")).toBe("2 H2 + O2 -> 2 H2O");
  });

  it("balances a long redox equation", () => {
    expect(balanced("KMnO4 + HCl -> KCl + MnCl2 + H2O + Cl2")).toBe(
      "2 KMnO4 + 16 HCl -> 2 KCl + 2 MnCl2 + 8 H2O + 5 Cl2",
    );
  });
});

describe("classification", () => {
  it("names a combustion", () => {
    expect(run("CH4 + O2 -> CO2 + H2O")["Reaction type"]).toBe("Combustion");
  });

  it("names a synthesis", () => {
    expect(classify(parseEquation("N2 + H2 -> NH3"))).toBe("Synthesis (combination)");
  });

  it("names a decomposition", () => {
    expect(classify(parseEquation("H2O2 -> H2O + O2"))).toBe("Decomposition");
  });

  it("names a single replacement", () => {
    expect(classify(parseEquation("Zn + HCl -> ZnCl2 + H2"))).toBe(
      "Single replacement (displacement)",
    );
  });

  it("names a neutralization", () => {
    expect(classify(parseEquation("HCl + NaOH -> NaCl + H2O"))).toBe(
      "Double replacement (neutralization)",
    );
  });

  it("flags a redox reaction", () => {
    expect(redoxHint(parseEquation("Zn + HCl -> ZnCl2 + H2"))).toMatch(/Likely redox/);
  });

  it("does not flag a metathesis as redox", () => {
    expect(redoxHint(parseEquation("HCl + NaOH -> NaCl + H2O"))).toMatch(/needs oxidation numbers/);
  });
});

describe("errors", () => {
  it("rejects an empty input", () => {
    expect(() => run("")).toThrow(/No equation/);
  });

  it("rejects an equation with no arrow", () => {
    expect(() => run("Fe + O2")).toThrow(/no arrow/);
  });

  it("rejects two arrows", () => {
    expect(() => run("A -> B -> C")).toThrow(ToolError);
  });

  it("rejects an empty side", () => {
    expect(() => run("Fe + O2 ->")).toThrow(/product side/);
  });

  it("rejects an equation that cannot be balanced", () => {
    try {
      run("Fe + O2 -> FeS");
      throw new Error("expected a ToolError");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("not-balanceable");
      expect((err as ToolError).fix).toMatch(/appears on the right/);
    }
  });

  it("rejects an ambiguous equation with two independent reactions", () => {
    try {
      run("H2 + O2 + N2 -> H2O + NO2");
      throw new Error("expected a ToolError");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("ambiguous-equation");
    }
  });

  it("rejects a zero coefficient", () => {
    expect(() => run("0 Fe + O2 -> Fe2O3")).toThrow(/coefficient of 0/);
  });
});

describe("run output", () => {
  it("reports the element balance for every element", () => {
    const out = run("Fe + O2 -> Fe2O3");
    expect(out["Balance check: Fe"]).toBe("4 left, 4 right, balanced");
    expect(out["Balance check: O"]).toBe("6 left, 6 right, balanced");
  });

  it("reports the charge balance on an ionic equation", () => {
    const out = run("Ag+ + Cl- -> AgCl");
    expect(out["Balance check: charge"]).toBe("0 left, 0 right, balanced");
  });

  it("lists every species with its coefficient", () => {
    const out = run("N2 + H2 -> NH3");
    expect(out["Reactant: N2"]).toBe("coefficient 1");
    expect(out["Reactant: H2"]).toBe("coefficient 3");
    expect(out["Product: NH3"]).toBe("coefficient 2");
  });

  it("adds molar masses when asked", () => {
    const out = run("N2 + H2 -> NH3", { showMasses: true });
    expect(out["Product: NH3"]).toMatch(/17\.0\d\d g\/mol/);
  });

  it("switches the arrow style and drops the states", () => {
    const out = run("Pb(NO3)2(aq) + KI(aq) -> PbI2(s) + KNO3(aq)", {
      arrow: "unicode",
      keepStates: false,
    });
    expect(out["Balanced equation"]).toBe("Pb(NO3)2 + 2 KI → PbI2 + 2 KNO3");
  });

  it("renders through the exported helper as well", () => {
    const result = balanceEquation("Zn + HCl -> ZnCl2 + H2");
    expect(renderEquation(result)).toBe("Zn + 2 HCl -> ZnCl2 + H2");
    expect(balance(result.species)).toEqual([1, 2, 1, 1]);
  });
});
