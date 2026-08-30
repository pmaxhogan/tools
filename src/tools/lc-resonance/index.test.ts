import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { run, __test__ } from "./index";

const { parseInductanceH, parseCapacitanceF, parseFrequencyHz, parseResistanceOhm } = __test__;

describe("lc-resonance: unit parsing", () => {
  it("parses inductance units", () => {
    expect(parseInductanceH("10uH")).toBeCloseTo(10e-6, 12);
    expect(parseInductanceH("100nH")).toBeCloseTo(100e-9, 15);
    expect(parseInductanceH("1mH")).toBeCloseTo(1e-3, 9);
    expect(parseInductanceH("2H")).toBeCloseTo(2, 6);
  });

  it("parses capacitance units", () => {
    expect(parseCapacitanceF("100pF")).toBeCloseTo(100e-12, 18);
    expect(parseCapacitanceF("1nF")).toBeCloseTo(1e-9, 15);
    expect(parseCapacitanceF("10uF")).toBeCloseTo(10e-6, 12);
  });

  it("parses frequency units", () => {
    expect(parseFrequencyHz("7.1MHz")).toBeCloseTo(7.1e6, 0);
    expect(parseFrequencyHz("500kHz")).toBeCloseTo(500e3, 0);
  });

  it("parses resistance with an optional k suffix", () => {
    expect(parseResistanceOhm("50")).toBe(50);
    expect(parseResistanceOhm("4.7k")).toBeCloseTo(4700, 0);
    expect(parseResistanceOhm("50ohm")).toBe(50);
  });
});

describe("lc-resonance: solving for the third value", () => {
  it("computes resonant frequency from L and C", () => {
    const out = run("L=10uH C=100pF", {} as never);
    const expectedF = 1 / (2 * Math.PI * Math.sqrt(10e-6 * 100e-12));
    expect(parseFloat(out["Resonant frequency"])).toBeCloseTo(expectedF / 1e6, 2); // MHz display
  });

  it("computes capacitance from L and f, and it round trips back to the same f", () => {
    const out = run("L=10uH f=7.1MHz", {} as never);
    const c = out["Capacitance"];
    expect(c).toBeDefined();
    const cMatch = c.match(/([\d.]+)\s*pF/);
    expect(cMatch).not.toBeNull();
    const cF = Number(cMatch?.[1]) * 1e-12;
    const roundTripF = 1 / (2 * Math.PI * Math.sqrt(10e-6 * cF));
    expect(roundTripF / 1e6).toBeCloseTo(7.1, 1);
  });

  it("computes inductance from C and f", () => {
    const out = run("C=100pF f=7.1MHz", {} as never);
    expect(out["Inductance"]).toBeDefined();
    expect(out["Resonant frequency"]).toContain("MHz");
  });

  it("accepts three consistent values without error", () => {
    const out = run("L=10uH C=100pF f=5.0329MHz", {} as never);
    expect(out["Resonant frequency"]).toBeDefined();
  });

  it("throws when three given values are inconsistent", () => {
    expect(() => run("L=10uH C=100pF f=1MHz", {} as never)).toThrow(ToolError);
  });
});

describe("lc-resonance: reactance, Q factor, and bandwidth", () => {
  it("reports equal XL and XC at resonance", () => {
    const out = run("L=10uH C=100pF", {} as never);
    expect(out["Reactance at resonance (XL = XC)"]).toBeDefined();
  });

  it("computes Q factor and bandwidth when a series resistance is given", () => {
    const out = run("L=10uH C=100pF R=5", {} as never);
    const q = parseFloat(out["Q factor"]);
    expect(q).toBeGreaterThan(0);
    expect(out["Bandwidth (-3dB, series RLC)"]).toMatch(/kHz|Hz|MHz/);
    // A higher series resistance should lower Q for the same L and C.
    const outHigherR = run("L=10uH C=100pF R=50", {} as never);
    expect(parseFloat(outHigherR["Q factor"])).toBeLessThan(q);
  });

  it("omits Q factor and bandwidth when no resistance is given", () => {
    const out = run("L=10uH C=100pF", {} as never);
    expect(out["Q factor"]).toBeUndefined();
    expect(out["Bandwidth (-3dB, series RLC)"]).toBeUndefined();
  });
});

describe("lc-resonance: errors", () => {
  it("throws on empty input", () => {
    expect(() => run("", {} as never)).toThrow(ToolError);
  });

  it("throws when fewer than two of L, C, f are given", () => {
    expect(() => run("L=10uH", {} as never)).toThrow(ToolError);
  });

  it("throws on a token without an equals sign", () => {
    expect(() => run("10uH 100pF", {} as never)).toThrow(ToolError);
  });

  it("throws on an unrecognized key", () => {
    expect(() => run("L=10uH X=100pF", {} as never)).toThrow(ToolError);
  });

  it("throws on a non-positive L or C", () => {
    expect(() => run("L=-10uH C=100pF", {} as never)).toThrow(ToolError);
    expect(() => run("L=10uH C=0pF", {} as never)).toThrow(ToolError);
  });

  it("throws on an unparseable unit", () => {
    expect(() => run("L=10furlongs C=100pF", {} as never)).toThrow(ToolError);
  });
});
