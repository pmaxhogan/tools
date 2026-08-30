import { describe, expect, it } from "vitest";
import { ISOTOPES, parseAmount, parseFields, parseRate, parseTime, run, solveDecay } from "./index";
import { ToolError } from "../types";

const YEAR = 31557600;

describe("parseFields", () => {
  it("reads comma separated pairs", () => {
    const f = parseFields("halfLife=5700 y, t=11400 y");
    expect(f.halfLife).toBeCloseTo(5700 * YEAR, 3);
    expect(f.elapsed).toBeCloseTo(11400 * YEAR, 3);
  });

  it("reads space separated pairs with units", () => {
    const f = parseFields("halfLife=8.0252 d t=24 h N0=100 mg");
    expect(f.halfLife).toBeCloseTo(8.0252 * 86400, 6);
    expect(f.elapsed).toBeCloseTo(86400, 6);
    expect(f.initial).toEqual({ value: 0.1, kind: "mass", unit: "mg" });
  });

  it("accepts a colon instead of an equals sign", () => {
    expect(parseFields("t: 60 min").elapsed).toBe(3600);
  });

  it("rejects an unknown field", () => {
    expect(() => parseFields("banana=3")).toThrow(/not a value this tool knows/);
  });

  it("rejects input with no pairs", () => {
    expect(() => parseFields("just some words")).toThrow(/looks like a value/);
  });
});

describe("unit parsing", () => {
  it("converts times to seconds", () => {
    expect(parseTime("1 y", "t")).toBe(YEAR);
    expect(parseTime("90", "t")).toBe(90);
  });

  it("rejects an unknown time unit", () => {
    expect(() => parseTime("5 furlongs", "t")).toThrow(/not a time unit/);
  });

  it("converts a decay constant to per second", () => {
    expect(parseRate("1 /y", "lambda")).toBeCloseTo(1 / YEAR, 15);
    expect(parseRate("2 per day", "lambda")).toBeCloseTo(2 / 86400, 15);
    expect(parseRate("0.5 s^-1", "lambda")).toBe(0.5);
  });

  it("reads percentages, masses, moles, counts and activities", () => {
    expect(parseAmount("25%", "N")).toEqual({ value: 0.25, kind: "relative", unit: "%" });
    expect(parseAmount("2 kg", "N0")).toEqual({ value: 2000, kind: "mass", unit: "kg" });
    expect(parseAmount("3 mmol", "N0")).toMatchObject({ kind: "mole" });
    expect(parseAmount("1e12 atoms", "N0")).toMatchObject({ kind: "count", value: 1e12 });
    expect(parseAmount("5 mCi", "N0")).toMatchObject({ kind: "activity", value: 5 * 3.7e7 });
  });

  it("rejects an unknown amount unit", () => {
    expect(() => parseAmount("5 buckets", "N0")).toThrow(/not an amount unit/);
  });
});

describe("solveDecay", () => {
  it("halves the sample after one half-life", () => {
    const s = solveDecay("halfLife=10 s, t=10 s");
    expect(s.remainingFraction).toBeCloseTo(0.5, 12);
    expect(s.halfLivesElapsed).toBeCloseTo(1, 12);
  });

  it("derives the decay constant and the mean lifetime", () => {
    const s = solveDecay("halfLife=10 s, t=0 s");
    expect(s.decayConstant).toBeCloseTo(Math.LN2 / 10, 12);
    expect(s.meanLife).toBeCloseTo(10 / Math.LN2, 12);
  });

  it("accepts a decay constant instead of a half-life", () => {
    const s = solveDecay("lambda=0.0693147 /s, t=10 s");
    expect(s.halfLife).toBeCloseTo(10, 4);
  });

  it("accepts a mean lifetime instead of a half-life", () => {
    const s = solveDecay("tau=100 s, t=0 s");
    expect(s.halfLife).toBeCloseTo(100 * Math.LN2, 10);
  });

  it("takes the half-life from an isotope preset", () => {
    const s = solveDecay("t=5700 y", { isotope: "c-14" });
    expect(s.preset?.label).toBe("Carbon 14");
    expect(s.remainingFraction).toBeCloseTo(0.5, 10);
  });

  it("lets a typed half-life win over the preset", () => {
    const s = solveDecay("halfLife=1 s, t=1 s", { isotope: "c-14" });
    expect(s.halfLife).toBe(1);
  });

  it("solves for the time to reach a remaining fraction", () => {
    const s = solveDecay("halfLife=10 s, remaining=25%", { mode: "time" });
    expect(s.elapsed).toBeCloseTo(20, 10);
  });

  it("solves for the time from two absolute amounts", () => {
    const s = solveDecay("halfLife=10 s, N0=8 g, N=1 g", { mode: "time" });
    expect(s.elapsed).toBeCloseTo(30, 10);
  });

  it("works out the nuclei count from a mass and a mass number", () => {
    const s = solveDecay("halfLife=30.08 y, N0=1 g, molarMass=137, t=0 s");
    expect(s.initialNuclei).toBeCloseTo(6.02214076e23 / 137, -12);
  });

  it("works out the nuclei count from an activity", () => {
    const s = solveDecay("halfLife=10 s, N0=1000 Bq, t=0 s");
    expect(s.initialNuclei).toBeCloseTo(1000 / (Math.LN2 / 10), 6);
  });

  it("rejects two time constants at once", () => {
    expect(() => solveDecay("halfLife=10 s, tau=5 s, t=1 s")).toThrow(/three ways of writing/);
  });

  it("rejects a missing half-life", () => {
    expect(() => solveDecay("t=10 s")).toThrow(/No half-life/);
  });

  it("rejects a missing time in the remaining mode", () => {
    expect(() => solveDecay("halfLife=10 s")).toThrow(/No elapsed time/);
  });

  it("rejects a missing remainder in the time mode", () => {
    expect(() => solveDecay("halfLife=10 s", { mode: "time" })).toThrow(/needs the amount/);
  });

  it("rejects a remainder larger than the start", () => {
    expect(() => solveDecay("halfLife=10 s, N0=1 g, N=2 g", { mode: "time" })).toThrow(
      /decay cannot do/,
    );
  });

  it("rejects a remainder of zero", () => {
    expect(() => solveDecay("halfLife=10 s, remaining=0%", { mode: "time" })).toThrow(
      /never reaches exactly zero/,
    );
  });

  it("rejects mismatched amount kinds", () => {
    expect(() => solveDecay("halfLife=10 s, N0=1 g, N=1 mol", { mode: "time" })).toThrow(
      /different kinds of unit/,
    );
  });

  it("rejects a negative time", () => {
    expect(() => solveDecay("halfLife=10 s, t=-5 s")).toThrow(ToolError);
  });
});

describe("run", () => {
  it("reports the remaining amount and the half-life table", () => {
    const out = run("halfLife=10 s, t=20 s, N0=100 g", { timeUnit: "s", decimals: 4 });
    expect(out["Remaining fraction"]).toBe("25.0000%");
    expect(out["Remaining amount"]).toBe("25.0000 g");
    expect(out["Decayed amount"]).toBe("75.0000 g");
    expect(out["After 1 half-life"]).toBe("10.0000 s, 50.0000% left, 50.0000 g");
    expect(out["After 10 half-lives"]).toContain("0.0977% left");
  });

  it("can hide the table", () => {
    const out = run("halfLife=10 s, t=20 s", { showTable: false });
    expect(out["After 1 half-life"]).toBeUndefined();
  });

  it("reports the activity when the nuclei count is known", () => {
    const out = run("t=0 s, N0=1 ug", { isotope: "i-131", timeUnit: "d" });
    expect(out["Isotope"]).toContain("Iodine 131");
    expect(out["Starting activity"]).toMatch(/Bq/);
  });

  it("explains a missing activity instead of inventing one", () => {
    const out = run("halfLife=10 s, t=10 s, N0=1 g");
    expect(out["Activity"]).toMatch(/molarMass/);
  });

  it("names the elapsed time it solved for", () => {
    const out = run("remaining=12.5%", { isotope: "tc-99m", mode: "time", timeUnit: "h" });
    expect(out["Elapsed time"]).toContain("18.0201 h");
  });
});

describe("isotope presets", () => {
  it("has unique ids and positive half-lives", () => {
    const ids = ISOTOPES.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const iso of ISOTOPES) {
      expect(iso.halfLife).toBeGreaterThan(0);
      expect(iso.massNumber).toBeGreaterThan(0);
    }
  });
});
