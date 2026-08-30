import { describe, expect, it } from "vitest";
import {
  airDensity,
  altimeterSettingPa,
  densityAltitudeM,
  isaDensity,
  isaPressurePa,
  isaTemperatureK,
  pressureAltitudeM,
  run,
} from "./index";
import { ToolError } from "../types";

describe("ISA table values", () => {
  it("gives 1013.25 hPa and 288.15 K at 0 m", () => {
    expect(isaPressurePa(0) / 100).toBeCloseTo(1013.25, 2);
    expect(isaTemperatureK(0)).toBeCloseTo(288.15, 2);
    expect(isaDensity(0)).toBeCloseTo(1.225, 3);
  });

  it("gives 226.32 hPa and 216.65 K at 11,000 m, the tropopause", () => {
    expect(isaPressurePa(11000) / 100).toBeCloseTo(226.32, 1);
    expect(isaTemperatureK(11000)).toBeCloseTo(216.65, 1);
  });

  it("keeps temperature constant above the tropopause", () => {
    expect(isaTemperatureK(15000)).toBeCloseTo(216.65, 2);
    expect(isaTemperatureK(20000)).toBeCloseTo(216.65, 2);
  });

  it("pressure keeps falling above the tropopause", () => {
    expect(isaPressurePa(15000)).toBeLessThan(isaPressurePa(11000));
  });
});

describe("pressureAltitudeM", () => {
  it("inverts isaPressurePa at sea level and at the tropopause", () => {
    expect(pressureAltitudeM(101325)).toBeCloseTo(0, 1);
    expect(pressureAltitudeM(isaPressurePa(11000))).toBeCloseTo(11000, 0);
  });

  it("round trips at a middle altitude", () => {
    const h = 3000;
    expect(pressureAltitudeM(isaPressurePa(h))).toBeCloseTo(h, 1);
  });
});

describe("densityAltitudeM", () => {
  it("gives zero when actual density equals the ISA sea level density", () => {
    expect(densityAltitudeM(isaDensity(0))).toBeCloseTo(0, 1);
  });

  it("is higher than pressure altitude on a hot day", () => {
    // Station pressure at sea level, but temperature well above ISA's 15 C.
    const stationPressurePa = isaPressurePa(0);
    const hotTempK = 308.15; // 35 C
    const density = airDensity(stationPressurePa, hotTempK);
    const da = densityAltitudeM(density);
    const pa = pressureAltitudeM(stationPressurePa);
    expect(da).toBeGreaterThan(pa);
  });

  it("is lower than pressure altitude on a cold day", () => {
    const stationPressurePa = isaPressurePa(0);
    const coldTempK = 263.15; // -10 C
    const density = airDensity(stationPressurePa, coldTempK);
    const da = densityAltitudeM(density);
    const pa = pressureAltitudeM(stationPressurePa);
    expect(da).toBeLessThan(pa);
  });
});

describe("altimeterSettingPa", () => {
  it("equals station pressure at sea level", () => {
    expect(altimeterSettingPa(101325, 0)).toBeCloseTo(101325, 3);
  });

  it("is higher than station pressure above sea level", () => {
    expect(altimeterSettingPa(90000, 1000)).toBeGreaterThan(90000);
  });

  it("throws for an elevation outside the supported range", () => {
    expect(() => altimeterSettingPa(101325, -10)).toThrow(ToolError);
    expect(() => altimeterSettingPa(101325, 12000)).toThrow(ToolError);
  });
});

describe("run, forward mode", () => {
  it("reports near zero pressure and density altitude for a standard sea level day", () => {
    const out = run("", {
      mode: "forward",
      pressureUnit: "hPa",
      altitudeUnit: "m",
      temperatureUnit: "C",
      stationPressure: 1013.25,
      elevation: 0,
      temperature: 15,
    });
    expect(out["Pressure altitude"]).toMatch(/^0 m/);
    expect(out["Density altitude"]).toMatch(/^0 m/);
    expect(out["Altimeter setting (estimated QNH)"]).toMatch(/1,?013\.25 hPa/);
  });

  it("gives a density altitude above pressure altitude on a hot day", () => {
    const out = run("", {
      mode: "forward",
      pressureUnit: "hPa",
      altitudeUnit: "ft",
      temperatureUnit: "F",
      stationPressure: 1013.25,
      elevation: 0,
      temperature: 95,
    });
    const paFt = Number(/\(([\d.,]+) ft\)/.exec(out["Pressure altitude"]!)![1].replace(/,/g, ""));
    const daFt = Number(/\(([\d.,]+) ft\)/.exec(out["Density altitude"]!)![1].replace(/,/g, ""));
    expect(daFt).toBeGreaterThan(paFt);
  });

  it("throws for non-positive station pressure", () => {
    expect(() =>
      run("", {
        mode: "forward",
        pressureUnit: "hPa",
        altitudeUnit: "m",
        temperatureUnit: "C",
        stationPressure: 0,
        elevation: 0,
        temperature: 15,
      }),
    ).toThrow(ToolError);
  });

  it("throws for a temperature at or below absolute zero", () => {
    expect(() =>
      run("", {
        mode: "forward",
        pressureUnit: "hPa",
        altitudeUnit: "m",
        temperatureUnit: "C",
        stationPressure: 1013.25,
        elevation: 0,
        temperature: -300,
      }),
    ).toThrow(/absolute zero/);
  });
});

describe("run, reverse mode", () => {
  it("gives the ISA table values at 0 m", () => {
    const out = run("", { mode: "reverse", altitudeUnit: "m", altitude: 0 });
    expect(out["Standard pressure"]).toMatch(/1,?013\.25 hPa/);
    expect(out["Standard temperature"]).toMatch(/15(\.0)? C/);
  });

  it("gives the ISA table values at 11,000 m", () => {
    const out = run("", { mode: "reverse", altitudeUnit: "m", altitude: 11000 });
    expect(out["Standard pressure"]).toMatch(/226\.3/);
    expect(out["Standard temperature"]).toMatch(/-56\.5 C/);
    expect(out.Layer).toMatch(/Tropopause|isothermal|Troposphere/);
  });

  it("throws for an altitude outside the supported ISA range", () => {
    expect(() => run("", { mode: "reverse", altitudeUnit: "m", altitude: 25000 })).toThrow(
      ToolError,
    );
    expect(() => run("", { mode: "reverse", altitudeUnit: "m", altitude: -5 })).toThrow(ToolError);
  });
});
