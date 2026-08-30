import { describe, expect, it } from "vitest";
import {
  apparentTemperatureC,
  dewPointBuck,
  dewPointMagnus,
  heatIndexF,
  humidex,
  run,
  wetBulbC,
  windChillF,
} from "./index";
import { ToolError } from "../types";

function fahrenheitValue(text: string): number {
  const m = /\(([-\d.]+) F\)/.exec(text);
  if (!m) throw new Error(`no Fahrenheit value in "${text}"`);
  return Number(m[1]);
}

describe("windChillF", () => {
  it("matches the NWS reference of about -45 F for -20 F at 15 mph", () => {
    expect(windChillF(-20, 15)).toBeCloseTo(-45.0, 0);
  });
});

describe("heatIndexF", () => {
  it("matches the NWS reference of about 105 F for 90 F at 70% RH", () => {
    expect(heatIndexF(90, 70)).toBeCloseTo(106, 0);
  });
});

describe("dewPointMagnus", () => {
  it("gives a dew point below the air temperature", () => {
    expect(dewPointMagnus(32.2, 70)).toBeLessThan(32.2);
  });

  it("agrees roughly with the Buck constants", () => {
    const magnus = dewPointMagnus(20, 50);
    const buck = dewPointBuck(20, 50);
    expect(Math.abs(magnus - buck)).toBeLessThan(0.5);
  });
});

describe("wetBulbC and humidex and apparent temperature", () => {
  it("wet bulb sits between dew point and air temperature", () => {
    const t = 30;
    const rh = 50;
    const wb = wetBulbC(t, rh);
    const dew = dewPointMagnus(t, rh);
    expect(wb).toBeGreaterThan(dew);
    expect(wb).toBeLessThan(t);
  });

  it("humidex rises with a higher dew point", () => {
    expect(humidex(30, 25)).toBeGreaterThan(humidex(30, 10));
  });

  it("apparent temperature falls as wind speed rises", () => {
    expect(apparentTemperatureC(25, 50, 10)).toBeLessThan(apparentTemperatureC(25, 50, 0));
  });
});

describe("run", () => {
  it("reports wind chill, dew point, and skips heat index below 80 F", () => {
    const out = run("", {
      temperature: -20,
      temperatureUnit: "F",
      humidity: 40,
      windSpeed: 15,
      windUnit: "mph",
      dewPointMethod: "magnus",
    });
    expect(out["Wind chill (NWS)"]).toBeDefined();
    expect(fahrenheitValue(out["Wind chill (NWS)"]!)).toBeCloseTo(-45, 0);
    expect(out["Heat index (NWS Rothfusz)"]).toMatch(/Not applicable/);
    expect(out["Dew point"]).toMatch(/Magnus/);
  });

  it("reports heat index and skips wind chill above 50 F", () => {
    const out = run("", {
      temperature: 90,
      temperatureUnit: "F",
      humidity: 70,
      windSpeed: 5,
      windUnit: "mph",
      dewPointMethod: "magnus",
    });
    expect(out["Wind chill (NWS)"]).toMatch(/Not applicable/);
    expect(out["Heat index (NWS Rothfusz)"]).toBeDefined();
    expect(fahrenheitValue(out["Heat index (NWS Rothfusz)"]!)).toBeCloseTo(106, 0);
  });

  it("accepts Celsius input and converts units", () => {
    const out = run("", {
      temperature: 32.2,
      temperatureUnit: "C",
      humidity: 70,
      windSpeed: 5,
      windUnit: "mph",
      dewPointMethod: "magnus",
    });
    expect(out.Input).toMatch(/32\.2 C/);
  });

  it("uses the Buck dew point method when selected", () => {
    const out = run("", {
      temperature: 68,
      temperatureUnit: "F",
      humidity: 50,
      windSpeed: 0,
      windUnit: "mph",
      dewPointMethod: "buck",
    });
    expect(out["Dew point"]).toMatch(/Arden Buck/);
  });

  it("throws for a non-numeric temperature", () => {
    expect(() =>
      run("", {
        temperature: Number.NaN,
        temperatureUnit: "F",
        humidity: 50,
        windSpeed: 5,
        windUnit: "mph",
        dewPointMethod: "magnus",
      }),
    ).toThrow(ToolError);
  });

  it("throws for a temperature below absolute zero", () => {
    expect(() =>
      run("", {
        temperature: -300,
        temperatureUnit: "C",
        humidity: 50,
        windSpeed: 5,
        windUnit: "mph",
        dewPointMethod: "magnus",
      }),
    ).toThrow(/absolute zero/);
  });

  it("throws for humidity out of range", () => {
    expect(() =>
      run("", {
        temperature: 70,
        temperatureUnit: "F",
        humidity: 0,
        windSpeed: 5,
        windUnit: "mph",
        dewPointMethod: "magnus",
      }),
    ).toThrow(/Relative humidity/);
    expect(() =>
      run("", {
        temperature: 70,
        temperatureUnit: "F",
        humidity: 150,
        windSpeed: 5,
        windUnit: "mph",
        dewPointMethod: "magnus",
      }),
    ).toThrow(/Relative humidity/);
  });

  it("throws for negative wind speed", () => {
    expect(() =>
      run("", {
        temperature: 70,
        temperatureUnit: "F",
        humidity: 50,
        windSpeed: -5,
        windUnit: "mph",
        dewPointMethod: "magnus",
      }),
    ).toThrow(/negative/);
  });
});
