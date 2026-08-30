import { describe, expect, it } from "vitest";
import {
  parseAmountLine,
  run,
  solveStoichiometry,
  speciesMass,
  splitInput,
} from "./index";
import { ToolError } from "../types";

const RUST = ["Fe + O2 -> Fe2O3", "Fe: 10 g", "O2: 5 g"].join("\n");

/** Molar masses from the PubChem snapshot, so the tests move with the data. */
const M_FE = 55.84;
const M_O2 = 2 * 15.999;
const M_FE2O3 = 2 * 55.84 + 3 * 15.999;

describe("splitInput", () => {
  it("separates the equation from the amount lines", () => {
    expect(splitInput(RUST)).toEqual({
      equation: "Fe + O2 -> Fe2O3",
      amounts: ["Fe: 10 g", "O2: 5 g"],
    });
  });

  it("accepts semicolons and comments", () => {
    expect(splitInput("N2 + H2 -> NH3; # note\nN2 = 1 mol")).toEqual({
      equation: "N2 + H2 -> NH3",
      amounts: ["N2 = 1 mol"],
    });
  });

  it("rejects an empty input", () => {
    expect(() => splitInput("")).toThrow(/No reaction/);
  });

  it("rejects an input with no equation", () => {
    expect(() => splitInput("Fe: 10 g")).toThrow(/No chemical equation/);
  });

  it("rejects an equation with no amounts", () => {
    expect(() => splitInput("Fe + O2 -> Fe2O3")).toThrow(/no amounts/);
  });
});

describe("parseAmountLine", () => {
  it("reads a species, a number and a unit", () => {
    expect(parseAmountLine("Fe: 10 g")).toEqual({
      target: "Fe",
      value: 10,
      unit: "g",
      kind: "mass",
      actual: false,
    });
  });

  it("accepts an equals sign and a mole unit", () => {
    expect(parseAmountLine("O2 = 0.25 mol")).toMatchObject({ kind: "mole", value: 0.25 });
  });

  it("defaults a missing unit to grams", () => {
    expect(parseAmountLine("Fe: 10")).toMatchObject({ unit: "g", kind: "mass" });
  });

  it("flags a measured yield", () => {
    expect(parseAmountLine("actual Fe2O3: 12 g").actual).toBe(true);
  });

  it("rejects an unreadable line", () => {
    expect(() => parseAmountLine("ten grams of iron")).toThrow(ToolError);
  });

  it("rejects an unknown unit", () => {
    expect(() => parseAmountLine("Fe: 10 pounds")).toThrow(/not a unit/);
  });

  it("rejects a negative amount", () => {
    expect(() => parseAmountLine("Fe: -1 g")).toThrow(/negative/);
  });
});

describe("solveStoichiometry", () => {
  it("balances the equation and finds the limiting reagent", () => {
    const r = solveStoichiometry(RUST);
    expect(r.coefficients).toEqual([4, 3, 2]);
    expect(r.species[r.limitingIndex]!.formula).toBe("Fe");
    expect(r.extent).toBeCloseTo(10 / M_FE / 4, 8);
  });

  it("converts a mass to moles with the tabulated molar mass", () => {
    const r = solveStoichiometry(RUST);
    expect(r.supplied[0]).toBeCloseTo(10 / M_FE, 8);
    expect(r.supplied[1]).toBeCloseTo(5 / M_O2, 8);
  });

  it("reads a measured yield onto the product side", () => {
    const r = solveStoichiometry(`${RUST}\nactual Fe2O3: 12 g`);
    expect(r.measured[2]).toBeCloseTo(12 / M_FE2O3, 8);
  });

  it("treats a reactant with no amount as being in excess", () => {
    const r = solveStoichiometry("Fe + O2 -> Fe2O3\nFe: 10 g");
    expect(Object.keys(r.supplied)).toEqual(["0"]);
    expect(r.limitingIndex).toBe(0);
  });

  it("honors typed coefficients when auto balance is off", () => {
    const r = solveStoichiometry("4 Fe + 3 O2 -> 2 Fe2O3\nFe: 10 g", { autoBalance: false });
    expect(r.coefficients).toEqual([4, 3, 2]);
  });

  it("rejects unbalanced typed coefficients when auto balance is off", () => {
    expect(() =>
      solveStoichiometry("Fe + O2 -> Fe2O3\nFe: 10 g", { autoBalance: false }),
    ).toThrow(/do not balance/);
  });

  it("rejects an amount for a species that is not there", () => {
    expect(() => solveStoichiometry("Fe + O2 -> Fe2O3\nCu: 10 g")).toThrow(/not one of the/);
  });

  it("rejects a duplicate amount", () => {
    expect(() => solveStoichiometry("Fe + O2 -> Fe2O3\nFe: 10 g\nFe: 2 g")).toThrow(/twice/);
  });

  it("rejects amounts given only for products", () => {
    expect(() => solveStoichiometry("Fe + O2 -> Fe2O3\nactual Fe2O3: 12 g")).toThrow(
      /nothing to limit/,
    );
  });
});

describe("speciesMass", () => {
  it("adds the tabulated weights", () => {
    const r = solveStoichiometry(RUST);
    expect(speciesMass(r.species[2]!)).toBeCloseTo(M_FE2O3, 6);
  });
});

describe("run", () => {
  it("reports the theoretical yield in moles and grams", () => {
    const out = run(RUST);
    expect(out["Balanced equation"]).toBe("4 Fe + 3 O2 -> 2 Fe2O3");
    expect(out["Limiting reagent"]).toMatch(/^Fe /);
    const expected = (2 * (10 / M_FE)) / 4;
    expect(out["Theoretical yield: Fe2O3"]).toContain((expected * M_FE2O3).toFixed(4));
  });

  it("reports the excess left over", () => {
    const out = run(RUST);
    const leftOver = 5 / M_O2 - (3 * (10 / M_FE)) / 4;
    expect(out["Left over: O2"]).toContain(leftOver.toFixed(4));
    expect(out["Left over: Fe"]).toBe("none, this is the limiting reagent");
  });

  it("reports the percent yield when a measured amount is given", () => {
    const out = run(`${RUST}\nactual Fe2O3: 12 g`);
    const theoretical = (2 * (10 / M_FE)) / 4;
    const percent = (12 / M_FE2O3 / theoretical) * 100;
    expect(out["Percent yield: Fe2O3"]).toContain(`${percent.toFixed(2)}%`);
  });

  it("notes the reactants that were assumed to be in excess", () => {
    const out = run("Fe + O2 -> Fe2O3\nFe: 10 g");
    expect(out["Assumed in excess"]).toMatch(/^O2 /);
  });

  it("works from moles as well as grams", () => {
    const out = run("N2 + H2 -> NH3\nN2: 1 mol\nH2: 1 mol");
    expect(out["Balanced equation"]).toBe("N2 + 3 H2 -> 2 NH3");
    expect(out["Limiting reagent"]).toMatch(/^H2 /);
    expect(out["Theoretical yield: NH3"]).toContain("0.6667 mol");
  });

  it("honors the decimal places option", () => {
    const out = run(RUST, { decimals: 2 });
    expect(out["Reaction extent"]).toBe("0.04 mol of reaction as written");
  });
});
