import { describe, expect, it } from "vitest";
import {
  DIPOLE_GAIN_LINEAR,
  distanceForPowerDensity,
  estimateExposure,
  farFieldPowerDensityWm2,
  formatMeters,
  formatPowerDensity,
  formatWatts,
  toEirpWatts,
} from "./exposure";
import { mpeAt } from "./rules";

describe("power conversions", () => {
  it("converts ERP and transmitter power plus gain to EIRP", () => {
    expect(toEirpWatts(100, "eirp")).toBe(100);
    expect(toEirpWatts(100, "erp")).toBeCloseTo(164, 6);
    expect(toEirpWatts(100, "tx", 0)).toBe(100);
    expect(toEirpWatts(100, "tx", 10)).toBeCloseTo(1000, 6);
    expect(toEirpWatts(1, "tx", 2.15)).toBeCloseTo(DIPOLE_GAIN_LINEAR, 2);
  });

  it("computes far field power density and its inverse", () => {
    // 100 W EIRP at 10 m: 100 / (4 pi 100) = 0.0796 W/m2.
    const s = farFieldPowerDensityWm2(100, 10);
    expect(s).toBeCloseTo(0.0796, 3);
    expect(distanceForPowerDensity(100, s)).toBeCloseTo(10, 6);
  });
});

describe("estimateExposure", () => {
  it("passes a modest VHF station against the uncontrolled limit", () => {
    const est = estimateExposure({
      freqHz: 146e6,
      powerW: 50,
      powerKind: "erp",
      distanceM: 10,
      environment: "uncontrolled",
    })!;
    expect(est).not.toBeNull();
    expect(est.eirpW).toBeCloseTo(82, 6);
    expect(est.erpW).toBeCloseTo(50, 6);
    // 82 / (4 pi 100) W/m2 = 0.0653 W/m2 = 0.00653 mW/cm2 against a 0.2 mW/cm2 limit.
    expect(est.powerDensityMwCm2).toBeCloseTo(0.00653, 4);
    expect(est.limit?.powerDensityMwCm2).toBeCloseTo(0.2, 6);
    expect(est.percentOfLimit).toBeCloseTo(3.26, 1);
    expect(est.pass).toBe(true);
    expect(est.nearField).toBe(false);
    expect(est.complianceDistanceM).toBeCloseTo(Math.sqrt(82 / (4 * Math.PI * 2)), 6);
    expect(est.assumptions.length).toBeGreaterThanOrEqual(4);
  });

  it("fails a strong source close in and flags the near field", () => {
    const est = estimateExposure({
      freqHz: 7.1e6,
      powerW: 1500,
      powerKind: "eirp",
      distanceM: 1,
      environment: "uncontrolled",
    })!;
    expect(est.pass).toBe(false);
    expect(est.nearField).toBe(true);
    expect(est.assumptions.some((a) => a.includes("near field"))).toBe(true);
  });

  it("applies the duty cycle to the density and the exemption", () => {
    const full = estimateExposure({
      freqHz: 146e6,
      powerW: 100,
      powerKind: "eirp",
      distanceM: 3,
      environment: "uncontrolled",
    })!;
    const half = estimateExposure({
      freqHz: 146e6,
      powerW: 100,
      powerKind: "eirp",
      distanceM: 3,
      environment: "uncontrolled",
      dutyCycle: 0.5,
    })!;
    expect(half.powerDensityMwCm2).toBeCloseTo(full.powerDensityMwCm2 / 2, 9);
    expect(half.assumptions.some((a) => a.includes("50% duty cycle"))).toBe(true);
  });

  it("marks tiny sources exempt and returns no limit outside the FCC table", () => {
    const tiny = estimateExposure({
      freqHz: 2.45e9,
      powerW: 0.0005,
      powerKind: "eirp",
      distanceM: 0.5,
      environment: "uncontrolled",
    })!;
    expect(tiny.exempt).toBe(true);
    const low = estimateExposure({
      freqHz: 60e3,
      powerW: 10,
      powerKind: "eirp",
      distanceM: 10,
      environment: "controlled",
    })!;
    expect(low.limit).toBeNull();
    expect(low.pass).toBeNull();
    expect(low.percentOfLimit).toBeNull();
    expect(low.complianceDistanceM).toBeNull();
    expect(mpeAt(60e3)).toBeNull();
  });

  it("rejects impossible inputs", () => {
    const base = {
      freqHz: 1e9,
      powerW: 1,
      powerKind: "eirp" as const,
      distanceM: 1,
      environment: "uncontrolled" as const,
    };
    expect(estimateExposure({ ...base, powerW: 0 })).toBeNull();
    expect(estimateExposure({ ...base, distanceM: -1 })).toBeNull();
    expect(estimateExposure({ ...base, freqHz: Number.NaN })).toBeNull();
  });
});

describe("formatting", () => {
  it("picks readable units", () => {
    expect(formatPowerDensity(1.5)).toBe("1.5 mW/cm2");
    expect(formatPowerDensity(0.0025)).toBe("2.5 uW/cm2");
    expect(formatPowerDensity(0.0000004)).toBe("0.4 nW/cm2");
    expect(formatWatts(1500)).toBe("1.5 kW");
    expect(formatWatts(0.05)).toBe("50 mW");
    expect(formatMeters(0.2)).toBe("20 cm");
    expect(formatMeters(2500)).toBe("2.5 km");
  });
});
