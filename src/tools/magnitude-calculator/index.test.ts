import { describe, expect, it } from "vitest";
import {
  combinedMagnitude,
  distanceModulus,
  fluxRatio,
  limitingMagnitude,
  parseAngularSize,
  parseDistanceParsecs,
  run,
  surfaceBrightness,
  PC_IN_LY,
} from "./index";
import { ToolError } from "../types";

/**
 * Reference values and where they come from:
 *
 * - A magnitude difference of exactly 5 is a flux ratio of exactly 100:
 *   the definition of the Pogson scale, N. R. Pogson, MNRAS 17, 12 (1856).
 * - Absolute magnitude is the apparent magnitude at 10 parsecs, so the
 *   distance modulus at 10 pc is exactly 0: the definition.
 * - The Sun: apparent V magnitude -26.74 at 1 AU, absolute V magnitude
 *   +4.83. Both are the standard values quoted in the Astronomical
 *   Almanac and in Binney and Merrifield, "Galactic Astronomy", table 2.1.
 * - Sirius A: apparent V magnitude -1.46, Hipparcos parallax 379.21 mas
 *   (distance 2.637 pc), absolute V magnitude +1.43. Values from the
 *   Hipparcos catalog as reported by SIMBAD.
 * - Vega and Sirius differ by 1.49 magnitudes, a flux ratio near 3.95,
 *   which follows from the same two catalog magnitudes.
 * - 1 parsec = 3.2615637769 light years and 206264.80624709636 AU: the
 *   IAU 2015 definition of the parsec, 648000 / pi astronomical units.
 * - M31, the Andromeda Galaxy: integrated V magnitude 3.44 over an
 *   apparent size of about 190 by 60 arcminutes, giving a mean surface
 *   brightness near 22.2 magnitudes per square arcsecond. Magnitude and
 *   size from the RC3 catalog values reproduced in the NGC/IC project.
 * - A 200 mm telescope reaching about magnitude 14.2 is the 2.7 plus
 *   5 log10(D in mm) rule of thumb, quoted in Norton's Star Atlas and in
 *   Sky and Telescope's aperture tables.
 */

describe("the core relations", () => {
  it("makes five magnitudes exactly a hundredfold in flux", () => {
    expect(fluxRatio(0, 5)).toBeCloseTo(100, 9);
    expect(fluxRatio(0, 10)).toBeCloseTo(10000, 6);
  });

  it("puts the distance modulus at zero for ten parsecs", () => {
    expect(distanceModulus(10)).toBeCloseTo(0, 12);
    expect(distanceModulus(100)).toBeCloseTo(5, 12);
  });

  it("adds 1.505 magnitudes when the same light covers four times the area", () => {
    expect(surfaceBrightness(10, 4) - surfaceBrightness(10, 1)).toBeCloseTo(1.5051, 4);
  });

  it("brightens by 0.7526 magnitudes when a second identical star is added", () => {
    expect(combinedMagnitude([1, 1])).toBeCloseTo(1 - 2.5 * Math.log10(2), 9);
    expect(combinedMagnitude([1, 1])).toBeCloseTo(0.2474, 4);
  });

  it("matches the aperture rule of thumb for a 200 mm telescope", () => {
    expect(limitingMagnitude(200)).toBeCloseTo(14.2, 1);
  });
});

describe("parseDistanceParsecs", () => {
  it("converts every supported unit into parsecs", () => {
    expect(parseDistanceParsecs("1 pc")).toBeCloseTo(1, 12);
    expect(parseDistanceParsecs(`${PC_IN_LY} ly`)).toBeCloseTo(1, 9);
    expect(parseDistanceParsecs("1 kpc")).toBeCloseTo(1000, 9);
    expect(parseDistanceParsecs("1 Mpc")).toBeCloseTo(1e6, 3);
  });

  it("keeps kpc and Mpc apart by case", () => {
    expect(parseDistanceParsecs("1 Mpc") / parseDistanceParsecs("1 kpc")).toBeCloseTo(1000, 6);
  });

  it("rejects a unit it does not know", () => {
    expect(() => parseDistanceParsecs("5 furlongs")).toThrow(ToolError);
  });

  it("rejects a distance of zero or less", () => {
    expect(() => parseDistanceParsecs("0 pc")).toThrow(/not something light can travel/i);
    expect(() => parseDistanceParsecs("-3 pc")).toThrow(ToolError);
  });
});

describe("parseAngularSize", () => {
  it("reads one axis and two", () => {
    expect(parseAngularSize("30 arcsec")).toEqual({ major: 30, minor: 30 });
    expect(parseAngularSize("190x60 arcmin")).toEqual({ major: 190 * 60, minor: 60 * 60 });
  });

  it("lets each axis carry its own unit", () => {
    expect(parseAngularSize("2 arcmin x 30 arcsec")).toEqual({ major: 120, minor: 30 });
  });

  it("rejects a size with no unit", () => {
    expect(() => parseAngularSize("30")).toThrow(ToolError);
  });
});

describe("run", () => {
  it("recovers the Sun's absolute magnitude from its apparent magnitude at 1 AU", () => {
    const out = run("apparent: -26.74\ndistance: 1 au");
    expect(Number(out["Absolute magnitude (M)"])).toBeCloseTo(4.83, 2);
    expect(out.Solved).toContain("absolute magnitude");
  });

  it("recovers the Sun's apparent magnitude from its absolute magnitude", () => {
    const out = run("absolute: 4.83\ndistance: 1 au");
    expect(Number(out["Apparent magnitude (M)"] ?? out["Apparent magnitude (m)"])).toBeCloseTo(
      -26.74,
      2,
    );
  });

  it("gets Sirius A's absolute magnitude from its parallax", () => {
    const out = run("apparent: -1.46\nparallax: 379.21 mas");
    expect(Number(out["Absolute magnitude (M)"])).toBeCloseTo(1.43, 2);
    expect(out["Distance from parallax"]).toContain("2.637");
  });

  it("solves for distance when both magnitudes are known", () => {
    const out = run("m: -1.46\nM: 1.43");
    expect(out.Distance).toMatch(/^2\.64/);
    expect(out.Solved).toContain("distance");
  });

  it("keeps lower case m and upper case M apart", () => {
    const out = run("m: 5\nM: 0");
    expect(out["Apparent magnitude (m)"]).toBe("+5.000");
    expect(out["Absolute magnitude (M)"]).toBe("+0.000");
    expect(out["Distance modulus (m - M)"]).toBe("+5.000");
    expect(out.Distance).toMatch(/^100 pc/);
  });

  it("leaves apparent and absolute equal at ten parsecs", () => {
    const out = run("apparent: 7\ndistance: 10 pc");
    expect(Number(out["Absolute magnitude (M)"])).toBeCloseTo(7, 9);
    expect(out["Distance modulus (m - M)"]).toBe("+0.000");
  });

  it("subtracts extinction from the distance modulus", () => {
    const out = run("apparent: 10\ndistance: 1000 pc\nextinction: 1.0");
    expect(Number(out["Absolute magnitude (M)"])).toBeCloseTo(-1, 9);
    expect(out.Extinction).toContain("+10.000");
  });

  it("gives the flux ratio between Sirius and Vega", () => {
    const out = run("compare: -1.46, 0.03");
    expect(out["Flux ratio"]).toMatch(/^3\.94/);
    expect(out["Magnitude difference"]).toBe("+1.490");
  });

  it("combines several stars into one magnitude", () => {
    const out = run("combine: 2.0, 3.0, 4.0");
    // Fluxes add: 10^-0.8 + 10^-1.2 + 10^-1.6 = 0.24670, so -2.5 log10 = 1.5196.
    expect(out["Combined magnitude"]).toMatch(/^\+1\.52/);
    expect(out["Gain over the brightest"]).toMatch(/^\+0\.48/);
  });

  it("estimates a limiting magnitude for an aperture, with the caveat attached", () => {
    const out = run("aperture: 8 in");
    expect(Number(out["Limiting magnitude"].split(" ")[0])).toBeCloseTo(14.2, 1);
    expect(out["Limiting magnitude caveat"]).toContain("rule");
    expect(out["Light grasp"]).toContain("times the eye");
  });

  it("gets M31's mean surface brightness from its magnitude and size", () => {
    const out = run("apparent: 3.44\nsize: 190x60 arcmin");
    expect(Number(out["Surface brightness"].split(" ")[0])).toBeCloseTo(22.2, 1);
  });

  it("leads the distance row with the unit that was asked for", () => {
    const pc = run("apparent: 0\ndistance: 10 pc", { distanceUnit: "pc" });
    expect(pc.Distance).toMatch(/^10 pc/);
    const ly = run("apparent: 0\ndistance: 10 pc", { distanceUnit: "ly" });
    expect(ly.Distance).toMatch(/^32\.61/);
  });

  it("accepts semicolons and comment lines", () => {
    const out = run("# Sirius\napparent: -1.46; distance: 2.637 pc");
    expect(Number(out["Absolute magnitude (M)"])).toBeCloseTo(1.43, 2);
  });

  it("refuses an empty input with a worked example", () => {
    expect(() => run("")).toThrow(ToolError);
    expect(() => run("   ")).toThrow(/at least two/i);
  });

  it("refuses a field it does not know", () => {
    expect(() => run("brightness: 5")).toThrow(/not a field/i);
  });

  it("refuses a line that is not a field at all", () => {
    expect(() => run("42")).toThrow(ToolError);
  });

  it("refuses a single magnitude with nothing to pair it with", () => {
    expect(() => run("apparent: 5")).toThrow(/not enough/i);
  });

  it("refuses a comparison that is not a pair", () => {
    expect(() => run("compare: 1, 2, 3")).toThrow(/exactly two/i);
  });

  it("refuses a surface brightness with no magnitude to spread", () => {
    expect(() => run("absolute: 3\ndistance: 10 pc\nsize: 190x60 arcmin")).not.toThrow();
    expect(() => run("aperture: 200 mm\nsize: 30 arcsec")).toThrow(/total magnitude/i);
  });

  it("refuses a parallax of zero", () => {
    expect(() => run("apparent: 5\nparallax: 0 mas")).toThrow(ToolError);
  });
});
