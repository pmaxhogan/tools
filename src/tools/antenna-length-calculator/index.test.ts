import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { run, __test__ } from "./index";

const { parseFrequencyHz, resolveVf } = __test__;

function opts(overrides: Partial<Record<string, unknown>> = {}) {
  return { mode: "half-wave-dipole", conductor: "wire", customVf: 0, ...overrides } as never;
}

describe("antenna-length-calculator", () => {
  it("computes a half-wave dipole close to the classic 468/f formula", () => {
    const out = run("146.52 MHz", opts());
    expect(out["Half wave dipole length"]).toBeDefined();
    // 468 / 146.52 = 3.194 ft, our physics based value should be within 1%.
    const match = out["Half wave dipole length"].match(/\(([\d.]+) ft\)/);
    expect(match).not.toBeNull();
    const ft = Number(match?.[1]);
    expect(ft).toBeGreaterThan(3.16);
    expect(ft).toBeLessThan(3.23);
  });

  it("computes a quarter-wave vertical close to 234/f", () => {
    const out = run("146.52 MHz", opts({ mode: "quarter-wave-vertical" }));
    expect(out["Quarter wave length"]).toBeDefined();
    expect(out["Classic formula (234 / f, feet, MHz)"]).toContain("ft");
  });

  it("computes a full wave and 5/8 wave antenna", () => {
    const full = run("28 MHz", opts({ mode: "full-wave" }));
    expect(full["Full wave length"]).toBeDefined();
    const five8 = run("28 MHz", opts({ mode: "five-eighth-wave" }));
    expect(five8["5/8 wave length"]).toBeDefined();
    expect(five8["Note"]).toContain("loading coil");
  });

  it("computes a 3 element Yagi starter with reflector longer and director shorter than driven", () => {
    const out = run("146 MHz", opts({ mode: "yagi-3-element" }));
    const driven = parseFloat(out["Driven element (half-wave dipole)"]);
    const reflector = parseFloat(out["Reflector (about 5% longer than driven)"]);
    const director = parseFloat(out["Director (about 5% shorter than driven)"]);
    expect(reflector).toBeGreaterThan(driven);
    expect(director).toBeLessThan(driven);
    expect(out["Total boom length"]).toBeDefined();
  });

  it("supports tubing conductor and a custom velocity factor override", () => {
    const tubing = run("146.52 MHz", opts({ conductor: "tubing" }));
    expect(tubing["Velocity factor used"]).toContain("tubing");
    const custom = run("146.52 MHz", opts({ customVf: 0.8 }));
    expect(custom["Velocity factor used"]).toContain("custom");
  });

  it("accepts a bare number as MHz", () => {
    const out = run("146.52", opts());
    expect(out["Frequency"]).toBe("146.5200 MHz");
  });

  it("parses GHz and kHz suffixes", () => {
    expect(parseFrequencyHz("2.45GHz")).toBeCloseTo(2.45e9, 0);
    expect(parseFrequencyHz("500kHz")).toBeCloseTo(500e3, 0);
  });

  it("throws on empty input", () => {
    expect(() => run("", opts())).toThrow(ToolError);
    expect(() => run("   ", opts())).toThrow(ToolError);
  });

  it("throws on an unparseable frequency", () => {
    expect(() => run("not a frequency", opts())).toThrow(ToolError);
  });

  it("throws on a non-positive frequency", () => {
    expect(() => run("-5 MHz", opts())).toThrow(ToolError);
    expect(() => run("0 MHz", opts())).toThrow(ToolError);
  });

  it("throws when a custom velocity factor is out of range", () => {
    expect(() => run("146.52 MHz", opts({ customVf: 1.5 }))).toThrow(ToolError);
  });

  it("resolveVf falls back to the wire preset by default", () => {
    expect(resolveVf({ mode: "half-wave-dipole", conductor: "wire", customVf: 0 }).vf).toBe(0.95);
    expect(resolveVf({ mode: "half-wave-dipole", conductor: "tubing", customVf: 0 }).vf).toBe(0.98);
  });
});
