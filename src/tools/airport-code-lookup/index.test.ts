import { describe, expect, it } from "vitest";
import {
  compassPoint,
  findAirport,
  haversineKm,
  initialBearing,
  run,
  splitPairQuery,
  toDms,
} from "./index";
import { ToolError } from "../types";

describe("airport-code-lookup", () => {
  describe("single airport lookup", () => {
    it("matches an IATA code exactly, case-insensitively", () => {
      const out = run("ord", {});
      expect(out["Name"]).toBe("O'Hare International Airport");
      expect(out["IATA code"]).toBe("ORD");
      expect(out["ICAO code"]).toBe("KORD");
      expect(out["City"]).toBe("Chicago");
      expect(out["Country"]).toBe("United States");
      expect(out["Time zone"]).toBe("America/Chicago");
      expect(out["Coordinates (decimal)"]).toBe("41.9786, -87.9047");
      expect(out["Elevation"]).toMatch(/^204 m \(\d+ ft\)$/);
    });

    it("ranks an IATA exact match over an ICAO exact match", () => {
      const matches = findAirport("KORD");
      expect(matches[0]!.airport.iata).toBe("ORD");
      expect(matches[0]!.matchedOn).toBe("icao");
    });

    it("handles the LON quirk: a city item with no ICAO code", () => {
      const out = run("LON", {});
      expect(out["Name"]).toBe("London");
      expect(out["ICAO code"]).toBe("Not recorded");
      expect(out["Note"]).toMatch(/No ICAO code/);
    });

    it("handles the AAL quirk: resolves to the air base, not a civil airport", () => {
      const out = run("AAL", {});
      expect(out["Name"]).toBe("Aalborg Air Base");
      expect(out["ICAO code"]).toBe("EKYT");
    });

    it("falls back to Not recorded for a sparse row", () => {
      const out = run("LTJ", {});
      expect(out["Name"]).toBe("Bayingolin Luntai Airport");
      expect(out["ICAO code"]).toBe("Not recorded");
      expect(out["City"]).toBe("Not recorded");
      expect(out["Country"]).toBe("Not recorded");
      expect(out["Coordinates (decimal)"]).toBe("Not recorded");
      expect(out["Elevation"]).toBe("Not recorded");
    });

    it("throws an ambiguous error with suggestions when several airports tie on city", () => {
      // Chicago itself resolves cleanly to the CHI metro item (an exact name
      // match beats the city ties), so this uses Houston, which has no metro
      // row of its own and genuinely ties across four airports.
      expect(() => run("Houston", {})).toThrowError(ToolError);
      try {
        run("Houston", {});
      } catch (e) {
        const err = e as ToolError;
        expect(err.code).toBe("ambiguous");
        expect(err.fix).toMatch(/David Wayne Hooks Memorial Airport/);
      }
    });

    it("throws a no-match error for garbage", () => {
      try {
        run("zzzznotanairportzzzz", {});
      } catch (e) {
        expect((e as ToolError).code).toBe("no-match");
      }
    });

    it("throws an actionable empty-input error", () => {
      expect(() => run("", {})).toThrowError(ToolError);
      try {
        run("", {});
      } catch (e) {
        expect((e as ToolError).code).toBe("empty-input");
      }
    });
  });

  describe("pair mode: distance and bearing", () => {
    it("computes ORD to LHR great circle distance within 30 km of the known value", () => {
      const out = run("ORD to LHR", {});
      expect(out["Airport 1"]).toBe("O'Hare International Airport (ORD)");
      expect(out["Airport 2"]).toBe("London Heathrow Airport (LHR)");
      const km = Number(out["Distance (km)"]);
      expect(Math.abs(km - 6360)).toBeLessThan(30);
    });

    it("agrees on distance whether split by 'to' or by newline", () => {
      const byTo = run("ORD to LHR", {});
      const byNewline = run("ORD\nLHR", {});
      expect(byTo["Distance (km)"]).toBe(byNewline["Distance (km)"]);
    });

    it("reports a plausible eastward-leaning initial bearing from Chicago to London", () => {
      const out = run("ORD to LHR", {});
      const bearing = Number(out["Initial bearing"].split("°")[0]);
      expect(bearing).toBeGreaterThan(0);
      expect(bearing).toBeLessThan(90);
    });

    it("throws when one side has no recorded coordinates", () => {
      try {
        run("LTJ to ORD", {});
      } catch (e) {
        expect((e as ToolError).code).toBe("missing-coordinates");
      }
    });
  });

  describe("splitPairQuery", () => {
    it("splits on the word 'to'", () => {
      expect(splitPairQuery("ORD to LHR")).toEqual(["ORD", "LHR"]);
    });

    it("splits on two newline separated lines", () => {
      expect(splitPairQuery("ORD\nLHR")).toEqual(["ORD", "LHR"]);
    });

    it("returns undefined for a single query", () => {
      expect(splitPairQuery("ORD")).toBeUndefined();
    });
  });

  describe("toDms", () => {
    it("formats a clean fraction without rounding surprises", () => {
      expect(toDms(1.5, "N", "S")).toBe("1°30′0.0″N");
    });

    it("flips hemisphere on negative degrees", () => {
      expect(toDms(-45, "N", "S")).toBe("45°0′0.0″S");
    });
  });

  describe("haversineKm and initialBearing", () => {
    it("is zero for the same point", () => {
      expect(haversineKm({ lat: 41.98, lon: -87.9 }, { lat: 41.98, lon: -87.9 })).toBeCloseTo(0, 6);
    });

    it("bears due east along the equator", () => {
      expect(initialBearing({ lat: 0, lon: 0 }, { lat: 0, lon: 10 })).toBeCloseTo(90, 0);
    });

    it("bears due north along a meridian", () => {
      expect(initialBearing({ lat: 0, lon: 0 }, { lat: 10, lon: 0 })).toBeCloseTo(0, 0);
    });
  });

  describe("compassPoint", () => {
    it("maps the four cardinal directions", () => {
      expect(compassPoint(0)).toBe("N");
      expect(compassPoint(90)).toBe("E");
      expect(compassPoint(180)).toBe("S");
      expect(compassPoint(270)).toBe("W");
    });
  });
});
