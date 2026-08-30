import { describe, expect, it } from "vitest";
import {
  axisForPeriod,
  circularSpeed,
  escapeSpeed,
  formatDuration,
  hohmannTransfer,
  orbitalPeriod,
  parseAngleDegrees,
  parseInput,
  parseLengthKm,
  parseSpeedKmS,
  parseTimeSeconds,
  planeChangeDeltaV,
  run,
  visViva,
} from "./index";
import { ToolError } from "../types";
import { lookupBody } from "./bodies";

const EARTH_MU = 398600.4418;
const EARTH_MEAN_RADIUS = 6371.0084;

function firstNumber(text: string): number {
  const m = /-?[\d.]+/.exec(text);
  if (!m) throw new Error(`no number in "${text}"`);
  return Number(m[0]);
}

describe("circularSpeed and escapeSpeed", () => {
  it("escape speed is circular speed times the square root of 2", () => {
    const r = EARTH_MEAN_RADIUS + 400;
    const vCirc = circularSpeed(EARTH_MU, r);
    const vEsc = escapeSpeed(EARTH_MU, r);
    expect(vEsc / vCirc).toBeCloseTo(Math.SQRT2, 10);
  });

  it("matches the well known ISS-altitude circular speed of about 7.67 km/s", () => {
    const v = circularSpeed(EARTH_MU, EARTH_MEAN_RADIUS + 400);
    expect(v).toBeCloseTo(7.67, 1);
  });
});

describe("visViva", () => {
  it("gives the circular speed when r equals a", () => {
    const r = EARTH_MEAN_RADIUS + 500;
    expect(visViva(EARTH_MU, r, r)).toBeCloseTo(circularSpeed(EARTH_MU, r), 10);
  });

  it("throws when the radius is outside the orbit", () => {
    // a=7000, so the orbit never reaches r=20000 (that would need v^2 < 0).
    expect(() => visViva(EARTH_MU, 20000, 7000)).toThrow(ToolError);
    expect(() => visViva(EARTH_MU, 20000, 7000)).toThrow(/outside the orbit/);
  });
});

describe("orbitalPeriod and axisForPeriod", () => {
  it("round trip through Kepler's third law", () => {
    const a = EARTH_MEAN_RADIUS + 700;
    const period = orbitalPeriod(EARTH_MU, a);
    expect(axisForPeriod(EARTH_MU, period)).toBeCloseTo(a, 6);
  });

  it("gives the sidereal day for the geostationary semi-major axis", () => {
    const geoAxis = axisForPeriod(EARTH_MU, 86164.0905);
    expect(geoAxis).toBeCloseTo(42164.17, 1);
  });
});

describe("hohmannTransfer", () => {
  it("gives about 3.9 km/s total delta-v from a 300 km LEO to geostationary", () => {
    const r1 = EARTH_MEAN_RADIUS + 300;
    const r2 = EARTH_MEAN_RADIUS + 35786;
    const transfer = hohmannTransfer(EARTH_MU, r1, r2);
    expect(transfer.totalDeltaV).toBeCloseTo(3.895, 2);
    expect(transfer.firstBurn).toBeGreaterThan(0);
    expect(transfer.secondBurn).toBeGreaterThan(0);
  });

  it("signs both burns negative for a transfer to a lower orbit", () => {
    const transfer = hohmannTransfer(EARTH_MU, EARTH_MEAN_RADIUS + 35786, EARTH_MEAN_RADIUS + 300);
    expect(transfer.firstBurn).toBeLessThan(0);
    expect(transfer.secondBurn).toBeLessThan(0);
  });
});

describe("planeChangeDeltaV", () => {
  it("is zero for a zero degree turn and 2v for a 180 degree turn", () => {
    expect(planeChangeDeltaV(7.5, 0)).toBeCloseTo(0, 10);
    expect(planeChangeDeltaV(7.5, 180)).toBeCloseTo(15, 10);
  });
});

describe("unit parsing", () => {
  it("parses length units", () => {
    expect(parseLengthKm("400", "x")).toBe(400);
    expect(parseLengthKm("400 km", "x")).toBe(400);
    expect(parseLengthKm("1 AU", "x")).toBeCloseTo(149597870.7, 1);
    expect(parseLengthKm("1000 m", "x")).toBeCloseTo(1, 10);
  });

  it("parses speed units", () => {
    expect(parseSpeedKmS("1 km/s", "x")).toBe(1);
    expect(parseSpeedKmS("1000 m/s", "x")).toBeCloseTo(1, 10);
  });

  it("parses time units", () => {
    expect(parseTimeSeconds("1 h", "x")).toBe(3600);
    expect(parseTimeSeconds("1 day", "x")).toBe(86400);
  });

  it("parses angle units", () => {
    expect(parseAngleDegrees("180", "x")).toBe(180);
    expect(parseAngleDegrees(`${Math.PI} rad`, "x")).toBeCloseTo(180, 6);
  });

  it("throws on an unrecognized unit", () => {
    expect(() => parseLengthKm("5 furlongs", "altitude")).toThrow(ToolError);
    expect(() => parseLengthKm("5 furlongs", "altitude")).toThrow(/not a length unit/);
  });

  it("throws on an unreadable number", () => {
    expect(() => parseLengthKm("abc km", "altitude")).toThrow(/Could not read/);
  });
});

describe("parseInput", () => {
  it("reads a bare body name", () => {
    expect(parseInput("Mars").body).toEqual(lookupBody("Mars"));
  });

  it("reads key: value lines", () => {
    const parsed = parseInput("body: Earth\naltitude: 400 km\nto: 35786 km");
    expect(parsed.body?.name).toBe("Earth");
    expect(parsed.altitude).toBe(400);
    expect(parsed.targetAltitude).toBe(35786);
  });

  it("throws on empty input", () => {
    expect(() => parseInput("")).toThrow(ToolError);
    expect(() => parseInput("   ")).toThrow(/Describe an orbit/);
  });

  it("throws on an unknown field", () => {
    expect(() => parseInput("bogus: 5")).toThrow(/not a field this calculator knows/);
  });

  it("throws on an unknown body", () => {
    expect(() => parseInput("body: Krypton")).toThrow(
      /not a body this calculator has constants for/,
    );
  });

  it("throws on a bad eccentricity", () => {
    expect(() => parseInput("eccentricity: 1.5")).toThrow(/not a closed orbit/);
  });
});

describe("formatDuration", () => {
  it("picks a readable unit for a short and a long duration", () => {
    expect(formatDuration(30)).toMatch(/^30 s$/);
    expect(formatDuration(90000)).toMatch(/hours/);
    expect(formatDuration(86400 * 365.25 * 3)).toMatch(/years/);
  });
});

describe("run", () => {
  it("defaults to Earth and reports the geostationary orbit", () => {
    const out = run("Earth");
    expect(out.Body).toMatch(/Earth/);
    expect(out["Geostationary orbit"]).toMatch(/35,?786|35786/);
  });

  it("computes a circular orbit from an altitude", () => {
    const out = run("body: Earth\naltitude: 400 km");
    expect(out.Orbit).toMatch(/Circular/);
    expect(out["Circular velocity"]).toBeDefined();
    expect(firstNumber(out["Circular velocity"]!)).toBeCloseTo(7.67, 1);
  });

  it("computes a Hohmann transfer from LEO to GEO at about 3.9 km/s total", () => {
    const out = run("body: Earth\naltitude: 300 km\nto: 35786 km");
    expect(out["Total delta-v"]).toBeDefined();
    expect(firstNumber(out["Total delta-v"]!)).toBeCloseTo(3.895, 1);
  });

  it("accepts a custom body via mu and radius", () => {
    const out = run("mu: 398600.4418 km^3/s^2\nradius: 6371.0084 km\naltitude: 400 km");
    expect(out.Body).toMatch(/Custom/);
  });

  it("throws for a transfer with no starting orbit", () => {
    expect(() => run("body: Earth\nto: 35786 km")).toThrow(/needs a starting orbit/);
  });

  it("throws for an orbit that is not closed", () => {
    expect(() => run("body: Earth\neccentricity: 1.2")).toThrow(ToolError);
  });
});
