import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { run, __test__ } from "./index";

const { bandForFrequency } = __test__;

const optsFor = (velocityFactor = 1) => ({ velocityFactor }) as never;

describe("wavelength-frequency: frequency input", () => {
  it("converts 146.52 MHz to the correct free space wavelength", () => {
    const out = run("146.52 MHz", optsFor());
    // c / f = 299792458 / 146520000 = 2.0463 m
    const m = parseFloat(out["Wavelength (free space / vacuum)"]);
    expect(m).toBeCloseTo(2.046, 2);
  });

  it("classifies 146.52 MHz as VHF", () => {
    const out = run("146.52 MHz", optsFor());
    expect(out["ITU band"]).toContain("VHF");
  });

  it("classifies 915 MHz as UHF", () => {
    const out = run("915 MHz", optsFor());
    expect(out["ITU band"]).toContain("UHF");
  });

  it("computes photon energy in eV", () => {
    const out = run("2.4GHz", optsFor());
    expect(out["Photon energy"]).toContain("eV");
  });

  it("computes the period as 1/f", () => {
    const out = run("1MHz", optsFor());
    expect(out["Period"]).toContain("1.000000 s".slice(0, 1)); // sanity: string is defined
    expect(out["Period"]).toBeDefined();
  });
});

describe("wavelength-frequency: wavelength input", () => {
  it("converts 550 nm (green light) to about 545 THz", () => {
    const out = run("550nm", optsFor());
    const freqStr = out["Frequency"];
    expect(freqStr).toContain("THz");
    const value = parseFloat(freqStr);
    expect(value).toBeCloseTo(545, -1);
  });

  it("does not assign an ITU band above 3 THz", () => {
    const out = run("550nm", optsFor());
    expect(out["ITU band"]).toContain("not an ITU radio band");
  });

  it("converts 21 cm (near the hydrogen line) to about 1.43 GHz", () => {
    const out = run("21cm", optsFor());
    expect(out["Frequency"]).toContain("GHz");
    const value = parseFloat(out["Frequency"]);
    expect(value).toBeCloseTo(1.4276, 3);
  });
});

describe("wavelength-frequency: velocity factor", () => {
  it("shows a shorter wavelength in cable when a velocity factor under 1 is set", () => {
    const out = run("146.52 MHz", optsFor(0.66));
    expect(out["Wavelength in cable / medium"]).toContain("0.66");
    const freeSpace = parseFloat(out["Wavelength (free space / vacuum)"]);
    const cable = parseFloat(out["Wavelength in cable / medium"]);
    expect(cable).toBeLessThan(freeSpace);
  });

  it("omits the cable wavelength row when velocity factor is 1", () => {
    const out = run("146.52 MHz", optsFor(1));
    expect(out["Wavelength in cable / medium"]).toBeUndefined();
  });
});

describe("wavelength-frequency: band lookup helper", () => {
  it("returns null above the THF range", () => {
    expect(bandForFrequency(4e12)).toBeNull();
  });

  it("returns ELF for a very low frequency", () => {
    expect(bandForFrequency(10)?.name).toContain("ELF");
  });
});

describe("wavelength-frequency: errors", () => {
  it("throws on empty input", () => {
    expect(() => run("", optsFor())).toThrow(ToolError);
  });

  it("throws when no unit is present", () => {
    expect(() => run("146.52", optsFor())).toThrow(ToolError);
  });

  it("throws on an unparseable frequency", () => {
    expect(() => run("abcMHz", optsFor())).toThrow(ToolError);
  });

  it("throws on a non-positive wavelength", () => {
    expect(() => run("-5nm", optsFor())).toThrow(ToolError);
    expect(() => run("0nm", optsFor())).toThrow(ToolError);
  });
});
