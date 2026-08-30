import { describe, expect, it } from "vitest";
import { PKW_TABLE, pKwAt, parseFields, run, solvePh } from "./index";
import { ToolError } from "../types";

describe("pKwAt", () => {
  it("reads the table exactly at a listed temperature", () => {
    expect(pKwAt(25)).toBe(13.997);
    expect(pKwAt(0)).toBe(14.943);
    expect(pKwAt(100)).toBe(12.26);
  });

  it("interpolates between rows", () => {
    expect(pKwAt(65)).toBeCloseTo((13.017 + 12.8) / 2, 10);
  });

  it("clamps outside the table", () => {
    expect(pKwAt(-40)).toBe(14.943);
    expect(pKwAt(500)).toBe(12.26);
  });

  it("falls monotonically with temperature", () => {
    for (let i = 1; i < PKW_TABLE.length; i++) {
      expect(PKW_TABLE[i]!.pKw).toBeLessThan(PKW_TABLE[i - 1]!.pKw);
    }
  });
});

describe("parseFields", () => {
  it("reads a bare number as a pH", () => {
    expect(parseFields("3.4")).toEqual({ ph: 3.4 });
  });

  it("converts pKa and pKb to constants", () => {
    expect(parseFields("pKa=4.76").ka).toBeCloseTo(10 ** -4.76, 15);
    expect(parseFields("pKb=4.75").kb).toBeCloseTo(10 ** -4.75, 15);
  });

  it("accepts a molar unit on a concentration", () => {
    expect(parseFields("C=0.1 M").concentration).toBe(0.1);
  });

  it("rejects an empty input", () => {
    expect(() => parseFields("")).toThrow(/No value to work from/);
  });

  it("rejects an unknown field", () => {
    expect(() => parseFields("banana=3")).toThrow(/not a value this tool knows/);
  });
});

describe("convert mode", () => {
  it("turns a pH into the other three values", () => {
    const r = solvePh("pH=3.4");
    expect(r.h).toBeCloseTo(10 ** -3.4, 15);
    expect(r.poh).toBeCloseTo(13.997 - 3.4, 10);
    expect(r.oh).toBeCloseTo(10 ** -13.997 / 10 ** -3.4, 20);
  });

  it("starts from a hydroxide concentration", () => {
    const r = solvePh("OH=1e-3");
    expect(r.poh).toBeCloseTo(3, 10);
    expect(r.ph).toBeCloseTo(13.997 - 3, 10);
  });

  it("starts from a hydrogen ion concentration", () => {
    expect(solvePh("H=2.5e-4").ph).toBeCloseTo(-Math.log10(2.5e-4), 12);
  });

  it("rejects two of the four at once", () => {
    expect(() => solvePh("pH=3, pOH=11")).toThrow(/four views of the same equilibrium/);
  });

  it("rejects a mode with nothing to convert", () => {
    expect(() => solvePh("C=0.1")).toThrow(/needs one of pH/);
  });

  it("rejects a non positive ion concentration", () => {
    expect(() => solvePh("H=0")).toThrow(/greater than zero/);
  });
});

describe("strong acid and base", () => {
  it("gives pH 1 for a tenth molar strong acid", () => {
    expect(solvePh("C=0.1", { mode: "strong-acid" }).ph).toBeCloseTo(1, 6);
  });

  it("does not claim pH 8 for a very dilute strong acid", () => {
    const r = solvePh("C=1e-8", { mode: "strong-acid" });
    expect(r.ph).toBeGreaterThan(6.8);
    expect(r.ph).toBeLessThan(r.neutralPh);
    expect(r.waterMatters).toBe(true);
  });

  it("gives pH 13 for a tenth molar strong base", () => {
    const r = solvePh("C=0.1", { mode: "strong-base" });
    expect(r.poh).toBeCloseTo(1, 6);
    expect(r.ph).toBeCloseTo(13.997 - 1, 6);
  });

  it("multiplies the concentration through the protons option", () => {
    const r = solvePh("C=0.05", { mode: "strong-acid", protons: 2 });
    expect(r.ph).toBeCloseTo(1, 6);
  });

  it("rejects a mode with no concentration", () => {
    expect(() => solvePh("pH=3", { mode: "strong-acid" })).toThrow(/needs the concentration/);
  });
});

describe("weak acid and base", () => {
  it("solves acetic acid from the quadratic", () => {
    const r = solvePh("C=0.1, Ka=1.8e-5", { mode: "weak-acid" });
    expect(r.ph).toBeCloseTo(2.875, 3);
    expect(r.ionized).toBeCloseTo(0.013327, 5);
    expect(r.fivePercentRuleHolds).toBe(true);
  });

  it("accepts pKa instead of Ka", () => {
    const a = solvePh("C=0.1, pKa=4.7447", { mode: "weak-acid" });
    const b = solvePh("C=0.1, Ka=1.8e-5", { mode: "weak-acid" });
    expect(a.ph).toBeCloseTo(b.ph, 3);
  });

  it("flags a case where the square root shortcut fails", () => {
    const r = solvePh("C=0.001, Ka=1.8e-3", { mode: "weak-acid" });
    expect(r.fivePercentRuleHolds).toBe(false);
    expect(r.shortcutError).toBeGreaterThan(0.05);
  });

  it("solves a weak base through Kb", () => {
    const r = solvePh("C=0.1, Kb=1.8e-5", { mode: "weak-base" });
    expect(r.poh).toBeCloseTo(2.875, 3);
    expect(r.ph).toBeGreaterThan(r.neutralPh);
  });

  it("rejects a weak mode with no constant", () => {
    expect(() => solvePh("C=0.1", { mode: "weak-acid" })).toThrow(/needs Ka or pKa/);
  });

  it("rejects a negative concentration", () => {
    expect(() => solvePh("C=-1, Ka=1e-5", { mode: "weak-acid" })).toThrow(/cannot be negative/);
  });

  it("rejects a non positive constant", () => {
    expect(() => solvePh("C=0.1, Ka=0", { mode: "weak-acid" })).toThrow(ToolError);
  });
});

describe("temperature", () => {
  it("moves neutral away from 7 at 50 degrees", () => {
    const r = solvePh("pH=6.631", { temperature: "50" });
    expect(r.neutralPh).toBeCloseTo(6.631, 3);
    expect(r.poh).toBeCloseTo(6.631, 3);
  });

  it("calls a pH 7 solution basic at 50 degrees", () => {
    expect(run("pH=7", { temperature: "50" })["Verdict"]).toBe("Basic");
  });

  it("calls a pH 7 solution neutral at 25 degrees", () => {
    expect(run("pH=6.9985", { temperature: "25" })["Verdict"]).toBe(
      "Neutral for this temperature",
    );
  });
});

describe("run", () => {
  it("prints all four values plus the disclaimer", () => {
    const out = run("pH=3.4", { decimals: 3 });
    expect(out["pH"]).toBe("3.400");
    expect(out["pOH"]).toBe("10.597");
    expect(out["[H+]"]).toContain("mol/L");
    expect(out["Verdict"]).toBe("Acidic");
    expect(out["Note"]).toContain("Educational reference");
  });

  it("reports percent ionization and the five percent rule for a weak acid", () => {
    const out = run("C=0.1, Ka=1.8e-5", { mode: "weak-acid", decimals: 3 });
    expect(out["Percent ionization"]).toBe("1.333%");
    expect(out["Five percent rule"]).toContain("Would have held");
    expect(out["pKa"]).toBe("4.745");
    expect(out["Polyprotic note"]).toContain("first ionization step");
  });

  it("rejects an unknown mode", () => {
    expect(() => run("C=0.1", { mode: "nonsense" })).toThrow(/not a calculation this tool offers/);
  });
});
