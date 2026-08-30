import { describe, expect, it } from "vitest";
import { BUFFERS, parseFields, run, solveBuffer } from "./index";
import { ToolError } from "../types";

describe("parseFields", () => {
  it("reads pKa and both amounts", () => {
    expect(parseFields("pKa=4.76, HA=0.1, A=0.15")).toEqual({
      pKa: 4.76,
      acid: 0.1,
      base: 0.15,
    });
  });

  it("converts a Ka to a pKa", () => {
    expect(parseFields("Ka=1.8e-5").pKa).toBeCloseTo(4.7447, 4);
  });

  it("strips a molar unit", () => {
    expect(parseFields("HA=0.1 M").acid).toBe(0.1);
  });

  it("rejects an empty input", () => {
    expect(() => parseFields("")).toThrow(/No buffer to work out/);
  });

  it("rejects an unknown field", () => {
    expect(() => parseFields("banana=3")).toThrow(/not a value this tool knows/);
  });

  it("rejects a non positive Ka", () => {
    expect(() => parseFields("Ka=0")).toThrow(/greater than zero/);
  });
});

describe("solveBuffer in pH mode", () => {
  it("applies Henderson-Hasselbalch", () => {
    const r = solveBuffer("pKa=4.76, HA=0.1, A=0.15");
    expect(r.ph).toBeCloseTo(4.76 + Math.log10(1.5), 10);
    expect(r.ratio).toBeCloseTo(1.5, 12);
    expect(r.total).toBeCloseTo(0.25, 12);
  });

  it("fills the missing component in from the total", () => {
    const r = solveBuffer("pKa=4.76, total=0.25, A=0.15");
    expect(r.acid).toBeCloseTo(0.1, 12);
  });

  it("gives a pH equal to the pKa at a one to one ratio", () => {
    const r = solveBuffer("pKa=7.2, HA=0.05, A=0.05");
    expect(r.ph).toBeCloseTo(7.2, 12);
    expect(r.capacity).toBeCloseTo(0.5756462732485114 * 0.1, 10);
  });

  it("computes the strong base and strong acid tolerances", () => {
    const r = solveBuffer("pKa=4.76, HA=0.1, A=0.15");
    expect(r.baseTolerance).toBeCloseTo(1.35 / 16, 12);
    expect(r.acidTolerance).toBeCloseTo(0.135 / 1.15, 12);
  });

  it("flags a mixture outside the useful range", () => {
    expect(solveBuffer("pKa=4.76, HA=0.001, A=0.2").inUsefulRange).toBe(false);
    expect(solveBuffer("pKa=4.76, HA=0.1, A=0.15").inUsefulRange).toBe(true);
  });

  it("rejects a buffer missing one component", () => {
    expect(() => solveBuffer("pKa=4.76, HA=0.1")).toThrow(/both the weak acid/);
  });

  it("rejects a component of zero", () => {
    expect(() => solveBuffer("pKa=4.76, HA=0, A=0.1")).toThrow(/some of both/);
  });

  it("rejects a missing pKa", () => {
    expect(() => solveBuffer("HA=0.1, A=0.15")).toThrow(/No pKa/);
  });
});

describe("solveBuffer in ratio mode", () => {
  it("works the amounts out from a target pH", () => {
    const r = solveBuffer("pKa=4.76, pH=5.0, total=0.2", { mode: "ratio" });
    const ratio = 10 ** 0.24;
    expect(r.ratio).toBeCloseTo(ratio, 10);
    expect(r.base).toBeCloseTo((0.2 * ratio) / (1 + ratio), 10);
    expect(r.acid).toBeCloseTo(0.2 / (1 + ratio), 10);
    expect(r.ph).toBe(5);
  });

  it("defaults the total to one so the answer reads as fractions", () => {
    const r = solveBuffer("pKa=7.2, pH=7.2", { mode: "ratio" });
    expect(r.acid).toBeCloseTo(0.5, 10);
    expect(r.base).toBeCloseTo(0.5, 10);
  });

  it("rejects a ratio request with no target", () => {
    expect(() => solveBuffer("pKa=4.76, total=0.2", { mode: "ratio" })).toThrow(
      /needs the pH you are aiming at/,
    );
  });
});

describe("presets", () => {
  it("takes the pKa from a preset", () => {
    const r = solveBuffer("HA=0.1, A=0.1", { buffer: "acetate" });
    expect(r.source).toBe("preset");
    expect(r.pKa).toBeCloseTo(4.76, 10);
  });

  it("picks the ionization step of a polyprotic preset", () => {
    const r = solveBuffer("HA=0.1, A=0.1", { buffer: "phosphate", step: 2 });
    expect(r.pKa).toBeCloseTo(7.2, 10);
  });

  it("shifts a temperature sensitive preset", () => {
    const r = solveBuffer("HA=0.1, A=0.1", { buffer: "tris", temperature: 4 });
    expect(r.pKa).toBeCloseTo(8.06 + -0.028 * (4 - 25), 10);
    expect(r.presetPka).toBe(8.06);
  });

  it("lets a typed pKa win over the preset", () => {
    const r = solveBuffer("pKa=5, HA=0.1, A=0.1", { buffer: "tris" });
    expect(r.pKa).toBe(5);
    expect(r.source).toBe("typed");
  });

  it("rejects a step the preset does not have", () => {
    expect(() => solveBuffer("HA=0.1, A=0.1", { buffer: "acetate", step: 3 })).toThrow(
      /does not exist/,
    );
  });

  it("has unique ids and ordered pKa values", () => {
    const ids = BUFFERS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of BUFFERS) {
      expect(b.pKa.length).toBeGreaterThan(0);
      for (let i = 1; i < b.pKa.length; i++) expect(b.pKa[i]!).toBeGreaterThan(b.pKa[i - 1]!);
    }
  });
});

describe("run", () => {
  it("prints the buffer summary and the disclaimer", () => {
    const out = run("pKa=4.76, HA=0.1, A=0.15", { decimals: 4 });
    expect(out["pH"]).toBe("4.9361");
    expect(out["Base to acid ratio"]).toBe("1.5000 to 1");
    expect(out["Range check"]).toContain("Inside the useful range");
    expect(out["Strong base tolerated"]).toContain("0.0844");
    expect(out["Note"]).toContain("Educational reference");
  });

  it("prints the preparation sentence in ratio mode", () => {
    const out = run("pKa=4.76, pH=5.0, total=0.2", { mode: "ratio", decimals: 4 });
    expect(out["How to prepare"]).toContain("Mix the weak acid");
    expect(out["pH"]).toBe("5.0000");
  });

  it("converts to moles when a volume is given", () => {
    const out = run("pKa=4.76, HA=0.1, A=0.1, V=0.5", { decimals: 4 });
    expect(out["Moles of weak acid"]).toBe("0.0500 mol");
  });

  it("shows the preset note for a polyprotic buffer", () => {
    const out = run("HA=0.1, A=0.1", { buffer: "citrate", step: 2 });
    expect(out["Buffer"]).toContain("Citrate");
    expect(out["Buffer note"]).toContain("Triprotic");
  });

  it("throws a ToolError for a bad step", () => {
    expect(() => run("HA=0.1, A=0.1", { buffer: "tris", step: 9 })).toThrow(ToolError);
  });
});
