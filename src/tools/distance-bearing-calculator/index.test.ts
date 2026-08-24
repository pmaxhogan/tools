import { describe, expect, it } from "vitest";
import {
  compassPoint,
  decimalYearFromMs,
  finalBearing,
  haversineKm,
  initialBearing,
  magneticDeclination,
  midpoint,
  parsePoint,
  resolveUnit,
  run,
  sphereDestination,
  vincentyDirect,
  vincentyInverse,
} from "./index";
import { ToolError } from "../types";

const NYC = { lat: 40.7128, lon: -74.006 };
const LONDON = { lat: 51.5074, lon: -0.1278 };
const PARIS = { lat: 48.8566, lon: 2.3522 };

/** A fixed clock so nothing in this suite depends on the wall clock. */
const NOW = Date.UTC(2026, 5, 15); // 2026-06-15

const num = (row: string): number => Number(/-?\d+(?:\.\d+)?/.exec(row)?.[0]);

describe("distance-bearing-calculator: great circle", () => {
  it("measures New York to London on the sphere and the ellipsoid", () => {
    const out = run("40.7128, -74.0060\n51.5074, -0.1278", { now: NOW });
    expect(num(out["Distance (sphere)"])).toBeCloseTo(5570.2, 0);
    expect(num(out["Distance (WGS84 ellipsoid)"])).toBeCloseTo(5585.2, 0);
    expect(out["Distance (sphere)"]).toMatch(/ km$/);
  });

  it("reports the initial and final true bearings", () => {
    const out = run("40.7128, -74.0060\n51.5074, -0.1278", { now: NOW });
    expect(num(out["Initial bearing (true)"])).toBeCloseTo(51.2, 1);
    expect(out["Initial bearing (true)"]).toContain("(NE)");
    // The bearing swings east along a great circle, so arrival is not 51 degrees.
    expect(num(out["Final bearing (true)"])).toBeCloseTo(108.3, 1);
    expect(finalBearing(NYC, LONDON)).toBeCloseTo((initialBearing(LONDON, NYC) + 180) % 360, 9);
  });

  it("puts the midpoint half way along the same great circle", () => {
    const half = sphereDestination(NYC, initialBearing(NYC, LONDON), haversineKm(NYC, LONDON) / 2);
    const mid = midpoint(NYC, LONDON);
    expect(mid.lat).toBeCloseTo(half.lat, 9);
    expect(mid.lon).toBeCloseTo(half.lon, 9);
    // Equidistant from both ends, which is what a midpoint has to be.
    expect(haversineKm(NYC, mid)).toBeCloseTo(haversineKm(mid, LONDON), 9);
    expect(mid.lat).toBeCloseTo(52.368, 3);
    expect(mid.lon).toBeCloseTo(-41.29, 3);
  });

  it("agrees with published WGS84 geodesics", () => {
    // Reference values from Karney's GeographicLib on WGS84.
    const sydneyTokyo = vincentyInverse(
      { lat: -33.8688, lon: 151.2093 },
      { lat: 35.6762, lon: 139.6503 },
    );
    expect(sydneyTokyo.distanceKm).toBeCloseTo(7792.174827, 4);
    expect(sydneyTokyo.initialBearing).toBeCloseTo(349.997518, 4);

    const equator = vincentyInverse({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
    expect(equator.distanceKm).toBeCloseTo(111.319491, 4);

    const meridian = vincentyInverse({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
    expect(meridian.distanceKm).toBeCloseTo(110.574389, 4);
  });

  it("treats two identical points as zero distance without producing NaN", () => {
    const out = run("40.7128,-74.0060\n40.7128,-74.0060", { now: NOW });
    expect(num(out["Distance (sphere)"])).toBe(0);
    expect(out["Initial bearing (true)"]).toContain("not defined");
    expect(JSON.stringify(out)).not.toContain("NaN");
  });

  it("falls back to the sphere when Vincenty cannot converge", () => {
    // Nearly antipodal: the classic case where lambda oscillates forever.
    const out = run("0,0\n0.5,179.7", { now: NOW });
    expect(out["Distance (WGS84 ellipsoid)"]).toContain("did not converge");
    expect(vincentyInverse({ lat: 0, lon: 0 }, { lat: 0.5, lon: 179.7 }).converged).toBe(false);
  });
});

describe("distance-bearing-calculator: destination mode", () => {
  it("runs 100 km due east from the origin along the ellipsoid", () => {
    const out = run("from 0,0 bearing 90 distance 100km", { now: NOW });
    expect(out["Destination (WGS84 ellipsoid)"]).toContain("0.898315");
    // The sphere lands slightly further east because it is smaller at the equator.
    expect(out["Destination (sphere)"]).toContain("0.899320");
    expect(out["Bearing (true)"]).toContain("90.0");
  });

  it("matches published WGS84 direct solutions", () => {
    const d = vincentyDirect({ lat: 40.7, lon: -74 }, 45, 100);
    expect(d.lat).toBeCloseTo(41.333648174, 7);
    expect(d.lon).toBeCloseTo(-73.155288713, 7);
    expect(d.finalBearing).toBeCloseTo(45.554382, 4);
  });

  it("round trips through the inverse formula", () => {
    const dest = vincentyDirect(NYC, 137.5, 4321);
    const back = vincentyInverse(NYC, { lat: dest.lat, lon: dest.lon });
    expect(back.distanceKm).toBeCloseTo(4321, 6);
    expect(back.initialBearing).toBeCloseTo(137.5, 8);
  });

  it("accepts a distance written in another unit", () => {
    const out = run("from 0,0 bearing 90 distance 54nmi", { units: "km", now: NOW });
    expect(num(out["Distance traveled"])).toBeCloseTo(100.008, 2);
    expect(out["Distance as written"]).toContain("nmi");
  });
});

describe("distance-bearing-calculator: routes", () => {
  it("adds up the legs of a three point route", () => {
    const out = run("40.7128,-74.0060\n51.5074,-0.1278\n48.8566,2.3522", { now: NOW });
    expect(out["Legs"]).toBe("2");
    expect(out["Leg 1 (point 1 to 2)"]).toContain("bearing 51.2");
    expect(out["Leg 2 (point 2 to 3)"]).toContain("bearing 148.1");
    const total = num(out["Total distance (sphere)"]);
    expect(total).toBeCloseTo(haversineKm(NYC, LONDON) + haversineKm(LONDON, PARIS), 2);
    expect(num(out["Total distance (WGS84 ellipsoid)"])).toBeCloseTo(5585.23 + 343.92, 1);
    expect(out["Point 3"]).toContain("48.856600");
  });

  it("switches every distance row to the chosen unit", () => {
    const km = run("40.7128,-74.0060\n51.5074,-0.1278", { units: "km", now: NOW });
    const mi = run("40.7128,-74.0060\n51.5074,-0.1278", { units: "mi", now: NOW });
    const nmi = run("40.7128,-74.0060\n51.5074,-0.1278", { units: "nmi", now: NOW });
    const m = run("40.7128,-74.0060\n51.5074,-0.1278", { units: "m", now: NOW });
    expect(num(mi["Distance (sphere)"])).toBeCloseTo(num(km["Distance (sphere)"]) / 1.609344, 1);
    expect(num(nmi["Distance (sphere)"])).toBeCloseTo(num(km["Distance (sphere)"]) / 1.852, 1);
    expect(num(m["Distance (sphere)"])).toBeCloseTo(num(km["Distance (sphere)"]) * 1000, 0);
    expect(m["Distance (sphere)"]).toMatch(/ m$/);
  });

  it("resolves unit synonyms", () => {
    expect(resolveUnit("kilometers")).toBe("km");
    expect(resolveUnit("Nautical Miles")).toBe("nmi");
    expect(resolveUnit("furlongs")).toBe(null);
  });

  it("names the nearest compass point", () => {
    expect(compassPoint(0)).toBe("N");
    expect(compassPoint(45)).toBe("NE");
    expect(compassPoint(359)).toBe("N");
    expect(compassPoint(-90)).toBe("W");
  });
});

describe("distance-bearing-calculator: coordinate reading", () => {
  it("reads decimal degrees, DMS and hemisphere letters alike", () => {
    expect(parsePoint("40.7128, -74.0060")).toEqual({ lat: 40.7128, lon: -74.006 });
    const dms = parsePoint("40°42'46.1\"N 74°00'21.6\"W");
    expect(dms.lat).toBeCloseTo(40.7128, 4);
    expect(dms.lon).toBeCloseTo(-74.006, 4);
    // Longitude written first is unambiguous once the letters are there.
    const flipped = parsePoint("W 74.0060, N 40.7128");
    expect(flipped.lat).toBeCloseTo(40.7128, 6);
    expect(flipped.lon).toBeCloseTo(-74.006, 6);
  });

  it("splits points on semicolons as well as line breaks", () => {
    const out = run("40.7128,-74.0060; 51.5074,-0.1278", { now: NOW });
    expect(num(out["Distance (sphere)"])).toBeCloseTo(5570.2, 0);
  });
});

describe("distance-bearing-calculator: magnetic model", () => {
  // Official NOAA WMM2025 test values (decimal year, altitude km, latitude,
  // longitude, declination, inclination, total intensity).
  const VECTORS: [number, number, number, number, number, number, number][] = [
    [2025.0, 28, 89, -121, -99.77, 88.47, 56214.419888],
    [2025.0, 18, 0, 21, 1.29, -26.06, 32594.761714],
    [2025.5, 44, 33, -118, 11.1, 57.89, 44542.826874],
    [2025.5, 50, -70, -133, 57.21, -71.94, 53731.803175],
    [2026.0, 82, -64, 87, -81.74, -75.4, 55453.154865],
    [2027.0, 44, -43, -111, 24.31, -52.57, 36957.295441],
    [2028.0, 86, -85, -79, 41.09, -70.25, 49924.018042],
    [2029.5, 63, 88, 26, 36.52, 87.37, 55344.931586],
  ];

  it.each(VECTORS)(
    "matches the official WMM2025 test value at %s, %s km, %s, %s",
    (year, alt, lat, lon, dec, inc, total) => {
      const f = magneticDeclination(lat, lon, alt, year);
      expect(f.declination).toBeCloseTo(dec, 1);
      expect(Math.abs(f.declination - dec)).toBeLessThan(0.02);
      expect(Math.abs(f.inclination - inc)).toBeLessThan(0.02);
      expect(Math.abs(f.total - total)).toBeLessThan(0.1);
      expect(f.model).toBe("WMM-2025");
    },
  );

  it("keeps the components consistent with the derived quantities", () => {
    const f = magneticDeclination(40.7128, -74.006, 0, 2026.5);
    expect(Math.hypot(f.x, f.y)).toBeCloseTo(f.horizontal, 6);
    expect(Math.hypot(f.horizontal, f.z)).toBeCloseTo(f.total, 6);
    expect(f.inValidity).toBe(true);
  });

  it("reports the annual change of declination", () => {
    // The official table gives dD/dt 2.491706 deg/year at this point.
    const f = magneticDeclination(89, -121, 28, 2025.0);
    expect(f.declinationChange).toBeCloseTo(2.491706, 3);
  });

  it("adds declination and magnetic bearing rows for both points", () => {
    const out = run("40.7128,-74.0060\n51.5074,-0.1278\non 2026-06-15", {});
    expect(out["Magnetic declination at point 1"]).toContain("west");
    expect(out["Magnetic declination at point 2"]).toContain("east");
    expect(out["Declination model"]).toContain("WMM-2025");
    expect(out["Declination model"]).toContain("2025.0 to 2030.0");
    // Magnetic bearing is the true bearing less an east positive declination.
    const trueB = num(out["Initial bearing (true)"]);
    const dec = Number(/(-?\d+\.\d+)°/.exec(out["Magnetic declination at point 1"])?.[1]);
    expect(num(out["Magnetic bearing to steer"])).toBeCloseTo(trueB - dec, 0);
  });

  it("can be switched off", () => {
    const out = run("40.7128,-74.0060\n51.5074,-0.1278", { magnetic: false, now: NOW });
    expect(out["Magnetic declination at point 1"]).toBeUndefined();
    expect(out["Declination model"]).toBeUndefined();
  });

  it("flags a date outside the model's five year window", () => {
    const out = run("40.7128,-74.0060\n51.5074,-0.1278\non 2035-03-04", {});
    expect(out["Declination model"]).toContain("outside the published five year window");
  });

  it("converts a date to a decimal year in UTC", () => {
    expect(decimalYearFromMs(Date.UTC(2026, 0, 1))).toBe(2026);
    expect(decimalYearFromMs(Date.UTC(2026, 6, 2, 12))).toBeCloseTo(2026.5, 3);
  });

  it("accepts a decimal year on the date line", () => {
    const out = run("40.7128,-74.0060\n51.5074,-0.1278\non 2027.25", {});
    expect(out["Declination model"]).toContain("2027.250");
  });
});

describe("distance-bearing-calculator: errors", () => {
  it("empty-input", () => {
    expect(() => run("", {})).toThrowError(ToolError);
    try {
      run("   ", {});
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("need-two", () => {
    try {
      run("40.7128,-74.0060", { now: NOW });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("need-two");
      expect((e as ToolError).fix).toContain("second coordinate");
    }
  });

  it("unparseable names the offending token", () => {
    try {
      run("40.7 & -74\n51,0", { now: NOW });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("unparseable");
      expect((e as ToolError).message).toContain('"&"');
    }
  });

  it("unparseable when only one value is on the line", () => {
    try {
      run("40.7128\n51.5074,-0.1278", { now: NOW });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("unparseable");
    }
  });

  it("out-of-range", () => {
    try {
      run("95, -74\n51,0", { now: NOW });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("out-of-range");
      expect((e as ToolError).message).toContain("-90 to 90");
    }
    try {
      run("45, -274\n51,0", { now: NOW });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("out-of-range");
      expect((e as ToolError).message).toContain("-180 to 180");
    }
  });

  it("bad-destination on a malformed run", () => {
    for (const bad of [
      "from 40.7,-74 bearing xyz distance 100km",
      "from nowhere bearing 45 distance 100km",
      "from 40.7,-74 bearing 45 distance 100 parsecs",
    ]) {
      try {
        run(bad, { now: NOW });
        throw new Error(`should have thrown for ${bad}`);
      } catch (e) {
        expect((e as ToolError).code).toBe("bad-destination");
      }
    }
  });

  it("bad-destination when a run is mixed with loose coordinates", () => {
    try {
      run("from 0,0 bearing 90 distance 100km\n51.5074,-0.1278", { now: NOW });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-destination");
    }
  });

  it("bad-date", () => {
    for (const bad of ["on yesterday", "on 2026-02-30", "on 15/06/2026"]) {
      try {
        run(`40.7128,-74.0060\n51.5074,-0.1278\n${bad}`, {});
        throw new Error(`should have thrown for ${bad}`);
      } catch (e) {
        expect((e as ToolError).code).toBe("bad-date");
      }
    }
  });
});
