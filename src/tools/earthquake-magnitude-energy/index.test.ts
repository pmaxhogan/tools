import { describe, expect, it } from "vitest";
import {
  amplitudeRatio,
  energyFromMagnitude,
  energyRatio,
  magnitudeFromEnergy,
  magnitudeFromMoment,
  mmiEstimate,
  momentFromMagnitude,
  run,
  tntTons,
} from "./index";
import { ToolError } from "../types";

describe("momentFromMagnitude and magnitudeFromMoment", () => {
  it("gives about 5.6e22 N*m for a magnitude 9.1 earthquake", () => {
    expect(momentFromMagnitude(9.1)).toBeCloseTo(5.6234e22, -18);
  });

  it("round trips through the inverse", () => {
    expect(magnitudeFromMoment(momentFromMagnitude(7.3))).toBeCloseTo(7.3, 8);
  });

  it("throws for a non-positive moment", () => {
    expect(() => magnitudeFromMoment(0)).toThrow(ToolError);
    expect(() => magnitudeFromMoment(-5)).toThrow(ToolError);
  });
});

describe("energyFromMagnitude and magnitudeFromEnergy", () => {
  it("round trips through the inverse", () => {
    expect(magnitudeFromEnergy(energyFromMagnitude(6.7))).toBeCloseTo(6.7, 8);
  });

  it("throws for a non-positive energy", () => {
    expect(() => magnitudeFromEnergy(0)).toThrow(ToolError);
  });
});

describe("energyRatio and amplitudeRatio", () => {
  it("one whole magnitude unit is about 31.6 times the energy and 10 times the amplitude", () => {
    expect(energyRatio(6, 7)).toBeCloseTo(31.6228, 3);
    expect(amplitudeRatio(6, 7)).toBeCloseTo(10, 8);
  });

  it("Tohoku (9.1) released about 4000 times the energy of Northridge (6.7)", () => {
    expect(energyRatio(6.7, 9.1)).toBeCloseTo(3981, -1);
  });

  it("is the reciprocal in the other direction", () => {
    expect(energyRatio(7, 6)).toBeCloseTo(1 / energyRatio(6, 7), 8);
  });
});

describe("tntTons", () => {
  it("converts joules to tons of TNT using the thermochemical definition", () => {
    expect(tntTons(4.184e9)).toBeCloseTo(1, 8);
  });
});

describe("mmiEstimate", () => {
  it("rises with magnitude", () => {
    expect(mmiEstimate(2).numeral).toBe("I");
    expect(mmiEstimate(9.1).numeral).toMatch(/X/);
  });

  it("picks the right band at the boundaries", () => {
    expect(mmiEstimate(8.0).numeral).toBe("X or higher");
    expect(mmiEstimate(7.9).numeral).toBe("VIII to IX");
  });
});

describe("run, magnitude mode", () => {
  it("reports moment, energy, TNT equivalent and MMI for Northridge", () => {
    const out = run("", { mode: "magnitude", magnitude: 6.7 });
    expect(out.Magnitude).toMatch(/6\.7/);
    expect(out["Seismic moment"]).toMatch(/N\*m/);
    expect(out["Radiated energy"]).toMatch(/J$/);
    expect(out["TNT equivalent"]).toBeDefined();
    expect(out["Typical maximum Modified Mercalli Intensity"]).toBeDefined();
  });

  it("compares against the reference earthquakes", () => {
    const out = run("", { mode: "magnitude", magnitude: 6.7 });
    const key = Object.keys(out).find((k) => k.includes("Tohoku"));
    expect(key).toBeDefined();
    expect(out[key!]).toMatch(/energy/);
  });

  it("skips comparing an earthquake to itself", () => {
    const out = run("", { mode: "magnitude", magnitude: 9.1 });
    const key = Object.keys(out).find((k) => k.includes("Tohoku"));
    expect(key).toBeUndefined();
  });
});

describe("run, compare mode", () => {
  it("reports the energy and amplitude ratio between two magnitudes", () => {
    const out = run("", { mode: "compare", magnitudeA: 6, magnitudeB: 7 });
    expect(out["Energy ratio (B over A)"]).toMatch(/31\.6/);
    expect(out["Ground motion amplitude ratio (B over A)"]).toMatch(/^10\b/);
  });
});

describe("run, energy mode", () => {
  it("derives a magnitude close to 6.7 from Northridge's radiated energy", () => {
    const out = run("", { mode: "energy", energy: energyFromMagnitude(6.7), energyUnit: "J" });
    expect(out.Magnitude).toMatch(/6\.7/);
  });

  it("accepts kilotons and megatons of TNT", () => {
    const out = run("", { mode: "energy", energy: 15, energyUnit: "kt" });
    expect(out.Magnitude).toBeDefined();
    expect(out["Derived from"]).toMatch(/kiloton/);
  });
});

describe("run, moment mode", () => {
  it("derives a magnitude close to 9.1 from Tohoku's seismic moment", () => {
    const out = run("", { mode: "moment", moment: momentFromMagnitude(9.1), momentUnit: "N-m" });
    expect(out.Magnitude).toMatch(/9\.1/);
  });

  it("accepts dyne-cm", () => {
    const out = run("", {
      mode: "moment",
      moment: momentFromMagnitude(7.0) * 1e7,
      momentUnit: "dyne-cm",
    });
    expect(out.Magnitude).toMatch(/^Mw 7/);
  });
});
