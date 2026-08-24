import { describe, expect, it } from "vitest";
import { CURATED_QUERIES, DB_META, DB_PATH, run } from "./index";

describe("wikidata-cities-database", () => {
  it("points at the public sqlite file", () => {
    expect(DB_PATH).toBe("/data/wikidata-cities.sqlite");
  });

  it("reports row counts matching the bundled snapshot", () => {
    expect(DB_META.counts.cities).toBe(7622);
    expect(DB_META.counts.countries).toBe(255);
    expect(DB_META.license).toBe("CC0 1.0 (Wikidata)");
  });

  it("run() describes the database without touching SQL", () => {
    const out = run(undefined, {});
    expect(out["Database file"]).toBe("/data/wikidata-cities.sqlite");
    expect(out["Tables"]).toBe("cities, countries, meta");
    expect(out["Cities"]).toMatch(/7,622/);
    expect(out["Countries"]).toMatch(/255/);
    expect(out["Size"]).toMatch(/MB/);
    expect(out["License"]).toBe("CC0 1.0 (Wikidata)");
    expect(out["Snapshot built"]).toBe("2026-08-23");
    expect(out["Refresh script"]).toBe("scripts/prepare-wikidata.mjs");
    expect(out["Curated queries"]).toContain(String(CURATED_QUERIES.length));
  });

  it("has at least 8 curated queries", () => {
    expect(CURATED_QUERIES.length).toBeGreaterThanOrEqual(8);
  });

  it("gives every curated query a unique label", () => {
    const labels = CURATED_QUERIES.map((q) => q.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("gives every curated query a non-empty description", () => {
    for (const q of CURATED_QUERIES) {
      expect(q.description.length).toBeGreaterThan(10);
    }
  });

  it("every curated query starts with SELECT", () => {
    for (const q of CURATED_QUERIES) {
      expect(q.sql.trim().toUpperCase().startsWith("SELECT")).toBe(true);
    }
  });

  it("every curated query references the cities or countries table", () => {
    for (const q of CURATED_QUERIES) {
      expect(/\bcities\b/i.test(q.sql) || /\bcountries\b/i.test(q.sql)).toBe(true);
    }
  });

  it("no curated query has a semicolon beyond a single trailing one", () => {
    for (const q of CURATED_QUERIES) {
      const semicolons = (q.sql.match(/;/g) ?? []).length;
      expect(semicolons === 0 || (semicolons === 1 && q.sql.trim().endsWith(";"))).toBe(true);
    }
  });

  it("documents the :iso2 bind parameter used by the per-country query", () => {
    const q = CURATED_QUERIES.find((c) => c.sql.includes(":iso2"))!;
    expect(q).toBeDefined();
    expect(q.description).toMatch(/:iso2/);
  });

  it("documents the :lat and :lon bind parameters used by the nearest-city query", () => {
    const q = CURATED_QUERIES.find((c) => c.sql.includes(":lat") && c.sql.includes(":lon"))!;
    expect(q).toBeDefined();
    expect(q.description).toMatch(/:lat/);
    expect(q.description).toMatch(/:lon/);
  });

  it("joins cities to countries by the ISO alpha-2 code in the density query", () => {
    const q = CURATED_QUERIES.find((c) => c.label === "Most city-dense countries")!;
    expect(q.sql).toMatch(/JOIN cities/i);
    expect(q.sql).toMatch(/country_iso2/);
  });
});
