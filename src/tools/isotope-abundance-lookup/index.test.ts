import { describe, expect, it } from "vitest";
import { averageAtomicMass, elementName, findByMass, isotopesOf, parseQuery, run } from "./index";
import { ToolError } from "../types";

describe("parseQuery", () => {
  it("reads a symbol, a name and an atomic number as an element", () => {
    expect(parseQuery("C")).toEqual({ kind: "element", symbol: "C" });
    expect(parseQuery("carbon")).toEqual({ kind: "element", symbol: "C" });
    expect(parseQuery("6")).toEqual({ kind: "element", symbol: "C" });
  });

  it("reads an isotope written either way round", () => {
    expect(parseQuery("C-13")).toEqual({ kind: "isotope", symbol: "C", massNumber: 13 });
    expect(parseQuery("13C")).toEqual({ kind: "isotope", symbol: "C", massNumber: 13 });
    expect(parseQuery("carbon-13")).toEqual({ kind: "isotope", symbol: "C", massNumber: 13 });
  });

  it("reads a mass query in mass mode", () => {
    expect(parseQuery("34.96885", "mass")).toEqual({ kind: "mass", mass: 34.96885 });
  });

  it("throws on empty input", () => {
    expect(() => parseQuery("")).toThrow(ToolError);
    expect(() => parseQuery("   ")).toThrow(/No element or isotope/);
  });

  it("throws on an unknown element or bad mass", () => {
    expect(() => parseQuery("Xq")).toThrow(/not an element symbol/);
    expect(() => parseQuery("not a number", "mass")).toThrow(/not a relative atomic mass/);
  });
});

describe("elementName", () => {
  it("looks up the name from a symbol", () => {
    expect(elementName("Fe")).toBe("Iron");
    expect(elementName("C")).toBe("Carbon");
  });
});

describe("averageAtomicMass vs the published standard", () => {
  it("agrees with the IUPAC standard atomic weight within tolerance for carbon", () => {
    const entry = isotopesOf("C");
    const average = averageAtomicMass(entry);
    expect(Math.abs(average - entry.weight) / entry.weight).toBeLessThan(0.001);
  });

  it("agrees with the IUPAC standard atomic weight within tolerance for iron", () => {
    const entry = isotopesOf("Fe");
    const average = averageAtomicMass(entry);
    expect(Math.abs(average - entry.weight) / entry.weight).toBeLessThan(0.001);
  });

  it("stays within the documented wider tolerance for lithium, the extreme case", () => {
    const entry = isotopesOf("Li");
    const average = averageAtomicMass(entry);
    expect(Math.abs(average - entry.weight) / entry.weight).toBeLessThan(0.01);
  });
});

describe("isotopesOf", () => {
  it("throws a clear error for an element with no naturally occurring isotope", () => {
    expect(() => isotopesOf("Tc")).toThrow(ToolError);
    expect(() => isotopesOf("Tc")).toThrow(/no naturally occurring isotope/);
  });
});

describe("findByMass", () => {
  it("finds the isotope whose relative atomic mass is nearest a given mass", () => {
    const matches = findByMass(12, 0.05);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.symbol).toBe("C");
    expect(matches[0]!.row[0]).toBe(12);
  });

  it("returns nothing outside the tolerance", () => {
    expect(findByMass(12.5, 0.0000001)).toEqual([]);
  });
});

describe("run", () => {
  it("looks up an element by symbol", () => {
    const out = run("C");
    expect(out["Element"]).toMatch(/Carbon \(C\)/);
    expect(out["C-12"]).toBeDefined();
    expect(out["C-13"]).toBeDefined();
    expect(out["Computed average atomic mass"]).toMatch(/u$/);
    expect(out["Standard atomic weight"]).toMatch(/IUPAC/);
    expect(out["Source"]).toMatch(/NIST/);
  });

  it("looks up a single isotope with mass number", () => {
    const out = run("C-13");
    expect(out["Isotope"]).toBe("C-13");
    expect(out["Neutrons"]).toBe("7");
    expect(out["Natural abundance"]).toMatch(/%/);
  });

  it("searches by mass in mass mode", () => {
    const out = run("12", { mode: "mass", massTolerance: 0.01 });
    expect(out["Matches"]).toBe("1");
    expect(out["C-12"]).toBeDefined();
  });

  it("throws for an isotope that is not naturally occurring", () => {
    expect(() => run("C-14")).toThrow(ToolError);
    expect(() => run("C-14")).toThrow(/not one of the naturally occurring isotopes/);
  });

  it("throws for an unknown element", () => {
    expect(() => run("Unobtainium")).toThrow(/not an element symbol, name or atomic number/);
  });

  it("throws for empty input", () => {
    expect(() => run("")).toThrow(ToolError);
  });

  it("throws for an element with no natural isotopes", () => {
    expect(() => run("Tc")).toThrow(/no naturally occurring isotope/);
  });

  it("throws for a mass with no match within tolerance", () => {
    expect(() => run("9999", { mode: "mass", massTolerance: 0.1 })).toThrow(
      /No naturally occurring isotope/,
    );
  });
});
