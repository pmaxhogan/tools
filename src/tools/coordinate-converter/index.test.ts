import { describe, expect, it } from "vitest";
import {
  compassPoint,
  fromGeohash,
  fromMgrs,
  fromPlusCode,
  fromUtm,
  haversineKm,
  initialBearing,
  latitudeBand,
  parseCoordinate,
  run,
  toDdm,
  toDms,
  toGeoUri,
  toGeohash,
  toMapLinks,
  toMgrs,
  toPlusCode,
  toUtm,
  utmZone,
} from "./index";
import { ToolError } from "../types";

/** New York City, the reference point used across these tests. */
const NYC = { lat: 40.7128, lon: -74.006 };
const LONDON = { lat: 51.5074, lon: -0.1278 };

describe("coordinate-converter parsing", () => {
  it("reads decimal degrees and converts every format", () => {
    const out = run("40.7128, -74.0060", {});
    expect(out["Detected format"]).toBe("Decimal degrees");
    expect(out["Decimal degrees"]).toBe("40.712800, -74.006000");
    expect(out["DMS"]).toBe("40°42'46.08\"N, 074°00'21.60\"W");
    expect(out["DDM"]).toBe("40°42.7680'N, 074°00.3600'W");
    expect(out["UTM"]).toBe("18T 583959 mE 4507351 mN (northern hemisphere)");
    expect(out["MGRS"]).toBe("18TWL8395907350");
    expect(out["Plus Code"]).toBe("87G7PX7V+4J");
    expect(out["geo URI"]).toBe("geo:40.712800,-74.006000");
    expect(out["Note"]).toMatch(/Order assumed/);
  });

  it("reads DMS with degree, prime and double prime marks", () => {
    const p = parseCoordinate("40°42'46.1\"N 74°00'21.6\"W");
    expect(p.format).toBe("DMS (degrees, minutes, seconds)");
    expect(p.lat).toBeCloseTo(40.712806, 6);
    expect(p.lon).toBeCloseTo(-74.006, 6);
  });

  it("reads DMS written with unicode primes and with d/m/s letters", () => {
    const unicode = parseCoordinate("40°42′46.1″N 74°00′21.6″W");
    const letters = parseCoordinate("40d42m46.1sN 74d0m21.6sW");
    expect(unicode.lat).toBeCloseTo(40.712806, 6);
    expect(letters.lat).toBeCloseTo(40.712806, 6);
    expect(letters.lon).toBeCloseTo(-74.006, 6);
    expect(letters.format).toBe("DMS (degrees, minutes, seconds)");
  });

  it("reads degrees with decimal minutes", () => {
    const p = parseCoordinate("40 42.768 N, 74 0.36 W");
    expect(p.format).toBe("DDM (degrees and decimal minutes)");
    expect(p.lat).toBeCloseTo(40.7128, 6);
    expect(p.lon).toBeCloseTo(-74.006, 6);
  });

  it("treats the first value as latitude when no letters are given, and says so", () => {
    const p = parseCoordinate("-74.0060,40.7128");
    expect(p.lat).toBeCloseTo(-74.006, 6);
    expect(p.lon).toBeCloseTo(40.7128, 6);
    expect(p.note).toMatch(/Order assumed/);
  });

  it("lets hemisphere letters override the order", () => {
    const p = parseCoordinate("74.0060 W 40.7128 N");
    expect(p.lat).toBeCloseTo(40.7128, 6);
    expect(p.lon).toBeCloseTo(-74.006, 6);
    expect(p.note).toMatch(/Longitude was written first/);
  });

  it("swaps an impossible latitude rather than failing", () => {
    const p = parseCoordinate("-122.4194, 37.7749");
    expect(p.lat).toBeCloseTo(37.7749, 6);
    expect(p.lon).toBeCloseTo(-122.4194, 6);
    expect(p.note).toMatch(/Order swapped/);
  });

  it("reads UTM with a band letter and with a hemisphere letter", () => {
    const banded = parseCoordinate("18T 583959 4507351");
    expect(banded.format).toBe("UTM");
    expect(banded.lat).toBeCloseTo(40.7128, 4);
    expect(banded.lon).toBeCloseTo(-74.006, 4);

    const hemi = parseCoordinate("18N 583959mE 4507351mN");
    expect(hemi.lat).toBeCloseTo(40.7128, 4);
    expect(hemi.note).toMatch(/hemisphere/);
  });

  it("reads MGRS at several precisions and records the cell size", () => {
    const meter = parseCoordinate("18TWL8395907350");
    expect(meter.format).toBe("MGRS");
    expect(meter.precisionMeters).toBe(1);
    expect(meter.lat).toBeCloseTo(40.7128, 4);
    expect(meter.lon).toBeCloseTo(-74.006, 4);

    expect(parseCoordinate("18TWL83950735").precisionMeters).toBe(10);
    expect(parseCoordinate("18T WL 839 073").precisionMeters).toBe(100);
    expect(parseCoordinate("18TWL").precisionMeters).toBe(100000);
    expect(parseCoordinate("18T WL 83 07").lat).toBeCloseTo(40.71, 2);
  });

  it("keeps a negative zero degree field pointing south", () => {
    const p = parseCoordinate("-0 30 0, 100 15");
    expect(p.lat).toBeCloseTo(-0.5, 9);
    expect(p.lon).toBeCloseTo(100.25, 9);
  });

  it("reads geo URIs, including the uncertainty parameter", () => {
    const p = parseCoordinate("geo:40.7128,-74.0060");
    expect(p.format).toBe("geo URI");
    expect(p.lat).toBeCloseTo(40.7128, 6);

    const withU = parseCoordinate("geo:40.7128,-74.0060;u=35");
    expect(withU.precisionMeters).toBe(35);

    // The pair splitter must not shear a geo URI on its own ";" parameters.
    expect(run("geo:40.7128,-74.0060;u=35", {})["Precision"]).toMatch(/About 35 m across/);
  });

  it("reads map links", () => {
    const g = parseCoordinate("https://www.google.com/maps/@40.7128,-74.0060,15z");
    expect(g.format).toBe("Google Maps link");
    expect(g.lat).toBeCloseTo(40.7128, 6);
    expect(g.lon).toBeCloseTo(-74.006, 6);

    const osm = parseCoordinate(toMapLinks(NYC.lat, NYC.lon).OpenStreetMap);
    expect(osm.lat).toBeCloseTo(40.7128, 5);
    expect(osm.lon).toBeCloseTo(-74.006, 5);
  });

  it("reads geohashes", () => {
    const p = parseCoordinate("ezs42");
    expect(p.format).toBe("Geohash (5 characters)");
    expect(p.lat).toBeCloseTo(42.6, 1);
    expect(p.lon).toBeCloseTo(-5.6, 1);
  });

  it("reads a full Plus Code", () => {
    const p = parseCoordinate("87G7PX7V+4J");
    expect(p.lat).toBeCloseTo(40.71281, 4);
    expect(p.lon).toBeCloseTo(-74.00594, 4);
    expect(p.plusCodeDigits).toBe(10);
  });
});

describe("coordinate-converter UTM and MGRS", () => {
  it("places New York in zone 18 band T", () => {
    const u = toUtm(NYC.lat, NYC.lon);
    expect(u.zone).toBe(18);
    expect(u.band).toBe("T");
    expect(u.hemisphere).toBe("N");
    expect(u.easting).toBeCloseTo(583959.372, 2);
    expect(u.northing).toBeCloseTo(4507350.998, 2);
  });

  it("applies the southwest Norway and Svalbard zone exceptions", () => {
    expect(utmZone(60, 5)).toBe(32);
    expect(utmZone(60, 2)).toBe(31);
    expect(utmZone(78, 15)).toBe(33);
    expect(latitudeBand(78)).toBe("X");
    expect(toUtm(78, 15).zone).toBe(33);
    expect(toUtm(78, 15).band).toBe("X");
    expect(utmZone(78, 25)).toBe(35);
    expect(utmZone(78, 40)).toBe(37);
    expect(utmZone(78, 5)).toBe(31);
  });

  it("round trips UTM to well under a centimeter", () => {
    const points = [
      { lat: 40.7128, lon: -74.006 },
      { lat: -33.8688, lon: 151.2093 },
      { lat: 0, lon: 0.5 },
      { lat: 78.2232, lon: 15.6469 },
      { lat: -54.8019, lon: -68.302 },
    ];
    for (const p of points) {
      const u = toUtm(p.lat, p.lon);
      const back = fromUtm(u.zone, u.hemisphere, u.easting, u.northing);
      // 1e-9 degrees is about 0.1 mm on the ground.
      expect(Math.abs(back.lat - p.lat)).toBeLessThan(1e-9);
      expect(Math.abs(back.lon - p.lon)).toBeLessThan(1e-9);
    }
  });

  it("round trips MGRS in both hemispheres and high latitudes", () => {
    const points = [
      { lat: 40.7128, lon: -74.006 },
      { lat: -33.8688, lon: 151.2093 },
      { lat: -54.8019, lon: -68.302 },
      { lat: 78.2232, lon: 15.6469 },
      { lat: 0.0001, lon: 9.4438 },
    ];
    for (const p of points) {
      const ref = toMgrs(p.lat, p.lon, 1);
      const back = fromMgrs(ref);
      expect(toMgrs(back.lat, back.lon, 1)).toBe(ref);
      expect(Math.abs(back.lat - p.lat)).toBeLessThan(1e-4);
      expect(Math.abs(back.lon - p.lon)).toBeLessThan(1e-4);
    }
  });

  it("truncates rather than rounds, at every precision", () => {
    expect(toMgrs(NYC.lat, NYC.lon, 1)).toBe("18TWL8395907350");
    expect(toMgrs(NYC.lat, NYC.lon, 10)).toBe("18TWL83950735");
    expect(toMgrs(NYC.lat, NYC.lon, 100)).toBe("18TWL839073");
    expect(toMgrs(NYC.lat, NYC.lon, 1000)).toBe("18TWL8307");
    expect(toMgrs(NYC.lat, NYC.lon, 10000)).toBe("18TWL80");
  });

  it("keeps the 100 km square letters in step with the zone", () => {
    // Odd and even zones use different row alphabets.
    expect(toMgrs(0, -177, 1).slice(0, 5)).toBe("1NEA0");
    expect(toMgrs(0, -171, 1).slice(0, 5)).toBe("2NNF0");
  });
});

describe("coordinate-converter Plus Codes", () => {
  it("matches the Open Location Code reference vectors", () => {
    expect(toPlusCode(20.375, 2.775, 6)).toBe("7FG49Q00+");
    expect(toPlusCode(20.3700625, 2.7821875, 10)).toBe("7FG49QCJ+2V");
    expect(toPlusCode(20.3701125, 2.782234375, 11)).toBe("7FG49QCJ+2VX");
    expect(toPlusCode(47.0000625, 8.0000625, 10)).toBe("8FVC2222+22");
  });

  it("decodes to the center of the code area", () => {
    const a = fromPlusCode("8FVC2222+22");
    expect(a.lat).toBeCloseTo(47.0000625, 9);
    expect(a.lon).toBeCloseTo(8.0000625, 9);
    expect(a.digits).toBe(10);

    const padded = fromPlusCode("7FG49Q00+");
    expect(padded.lat).toBeCloseTo(20.375, 9);
    expect(padded.lon).toBeCloseTo(2.775, 9);
    expect(padded.digits).toBe(6);
  });

  it("round trips through the encoder", () => {
    for (const length of [10, 11, 12, 13, 14, 15]) {
      const code = toPlusCode(NYC.lat, NYC.lon, length);
      const back = fromPlusCode(code);
      expect(toPlusCode(back.lat, back.lon, length)).toBe(code);
    }
  });
});

describe("coordinate-converter geohash", () => {
  it("matches the classic ezs42 example", () => {
    const a = fromGeohash("ezs42");
    expect(a.lat).toBeCloseTo(42.6, 1);
    expect(a.lon).toBeCloseTo(-5.6, 1);
    expect(toGeohash(42.6, -5.6, 5)).toBe("ezs42");
  });

  it("round trips at nine characters", () => {
    const hash = toGeohash(NYC.lat, NYC.lon, 9);
    const back = fromGeohash(hash);
    expect(toGeohash(back.lat, back.lon, 9)).toBe(hash);
    expect(back.lat).toBeCloseTo(NYC.lat, 4);
    expect(back.lon).toBeCloseTo(NYC.lon, 4);
  });
});

describe("coordinate-converter formatting", () => {
  it("formats DMS and DDM with padded fields", () => {
    expect(toDms(NYC.lat, NYC.lon)).toBe("40°42'46.08\"N, 074°00'21.60\"W");
    expect(toDdm(NYC.lat, NYC.lon)).toBe("40°42.7680'N, 074°00.3600'W");
    expect(toDms(-33.8688, 151.2093)).toBe("33°52'07.68\"S, 151°12'33.48\"E");
  });

  it("round trips DMS text back through the parser", () => {
    const text = toDms(NYC.lat, NYC.lon, 4);
    const back = parseCoordinate(text);
    expect(back.lat).toBeCloseTo(NYC.lat, 8);
    expect(back.lon).toBeCloseTo(NYC.lon, 8);
  });

  it("carries rounding out of the seconds field", () => {
    // 12.99999 degrees is 12 deg 59 min 59.964 sec, which rounds to a whole degree.
    expect(toDms(12.999999, 0, 2)).toBe("13°00'00.00\"N, 000°00'00.00\"E");
  });

  it("builds geo URIs and map links without fetching anything", () => {
    expect(toGeoUri(NYC.lat, NYC.lon)).toBe("geo:40.712800,-74.006000");
    const links = toMapLinks(NYC.lat, NYC.lon);
    expect(links["Google Maps"]).toBe(
      "https://www.google.com/maps/search/?api=1&query=40.712800,-74.006000",
    );
    expect(links["Apple Maps"]).toContain("maps.apple.com");
    expect(links.OpenStreetMap).toContain("openstreetmap.org");
  });
});

describe("coordinate-converter distance and bearing", () => {
  it("measures New York to London", () => {
    const km = haversineKm(NYC, LONDON);
    expect(km).toBeGreaterThan(5560);
    expect(km).toBeLessThan(5580);
    const bearing = initialBearing(NYC, LONDON);
    expect(bearing).toBeGreaterThan(50);
    expect(bearing).toBeLessThan(52);
    expect(compassPoint(bearing)).toBe("NE");
  });

  it("adds distance and bearing rows for two coordinates", () => {
    const out = run("40.7128, -74.0060; 51.5074, -0.1278", {});
    expect(out["Point 1 Decimal degrees"]).toBe("40.712800, -74.006000");
    expect(out["Point 2 Decimal degrees"]).toBe("51.507400, -0.127800");
    expect(out["Point 1 MGRS"]).toBe("18TWL8395907350");
    expect(Number.parseFloat(out["Distance"])).toBeCloseTo(5570, -1);
    expect(Number.parseFloat(out["Distance (miles)"])).toBeCloseTo(3461, -2);
    expect(out["Initial bearing"]).toMatch(/^5[01]\.\d° \(NE\)$/);
  });

  it("accepts two coordinates separated by a blank line", () => {
    const out = run("40.7128, -74.0060\n\n51.5074, -0.1278", {});
    expect(out["Distance"]).toBeDefined();
    expect(out["Point 2 Detected format"]).toBe("Decimal degrees");
  });
});

describe("coordinate-converter options", () => {
  it("honors the decimals option", () => {
    const out = run("40.7128, -74.0060", { decimals: 2 });
    expect(out["Decimal degrees"]).toBe("40.71, -74.01");
    expect(out["geo URI"]).toBe("geo:40.71,-74.01");
  });

  it("clamps the decimals option into range", () => {
    expect(run("40.7128, -74.0060", { decimals: 99 })["Decimal degrees"]).toBe(
      "40.71280000, -74.00600000",
    );
  });

  it("honors the MGRS precision option", () => {
    const out = run("40.7128, -74.0060", { mgrsPrecision: "1000" });
    expect(out["MGRS"]).toBe("18TWL8307");
  });

  it("drops the map links when asked", () => {
    const out = run("40.7128, -74.0060", { links: false });
    expect(out["Google Maps"]).toBeUndefined();
    expect(out["OpenStreetMap"]).toBeUndefined();
    expect(out["MGRS"]).toBeDefined();
  });

  it("reports the cell size of a coarse input", () => {
    expect(run("18TWL83950735", {})["Precision"]).toMatch(/About 10 m across/);
    expect(run("18TWL", {})["Precision"]).toMatch(/About 100 km across/);
  });

  it("still converts above the UTM grid instead of failing outright", () => {
    const out = run("87.0, 10.0", {});
    expect(out["UTM"]).toMatch(/stop at 84N and 80S/);
    expect(out["MGRS"]).toMatch(/stop at 84N and 80S/);
    expect(out["Decimal degrees"]).toBe("87.000000, 10.000000");
    expect(out["Plus Code"]).toBeDefined();
  });
});

describe("coordinate-converter errors", () => {
  it("rejects empty input", () => {
    expect(() => run("", {})).toThrowError(ToolError);
    try {
      run("   ", {});
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("names the token it could not read", () => {
    try {
      run("not a coordinate", {});
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("unparseable");
      expect((e as ToolError).message).toContain('"not"');
      expect((e as ToolError).fix).toMatch(/decimal degrees/i);
    }
  });

  it("rejects a single value", () => {
    expect(() => run("40.7128", {})).toThrowError(/expected a latitude and a longitude/);
  });

  it("rejects out of range values", () => {
    try {
      run("95, 200", {});
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("out-of-range");
      expect((e as ToolError).message).toMatch(/Latitude 95/);
    }
    expect(() => run("95N 200E", {})).toThrowError(ToolError);
  });

  it("rejects positions outside the UTM grid", () => {
    try {
      toUtm(85, 0);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("utm-out-of-band");
      expect((e as ToolError).fix).toMatch(/UPS/);
    }
    try {
      run("18Z 583959 4507523", {});
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("utm-out-of-band");
    }
    try {
      fromMgrs("18IWL8395907523");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("utm-out-of-band");
    }
  });

  it("rejects short Plus Codes with a way forward", () => {
    try {
      run("Q2MQ+6V", {});
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("short-plus-code");
      expect((e as ToolError).fix).toMatch(/eight characters/);
    }
  });

  it("rejects malformed MGRS and impossible minutes", () => {
    expect(() => fromMgrs("18TWL839590752")).toThrowError(/even count/);
    expect(() => run("40 75.0 N, 74 0.36 W", {})).toThrowError(/Minutes value 75/);
  });

  it("rejects more than two coordinates", () => {
    expect(() => run("1,2; 3,4; 5,6", {})).toThrowError(/converts one, or two/);
  });
});
