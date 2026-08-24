import { formatBytes } from "../../lib/format";
import type { ToolLogic } from "../types";

/**
 * Wikidata cities database: a thin description layer over the pre-built
 * SQLite file at DB_PATH, plus a set of curated queries for the bespoke
 * viewer panel that actually runs SQL against it in the browser.
 *
 * This file stays pure by contract (PROJECT.md rule 27), so it never opens
 * the database itself. It only describes what is in it and hands the panel
 * a set of well-formed starting queries. `run()` is the stateless API
 * surface: it reports the database's shape, not any query result.
 *
 * Schema (three tables, built by scripts/prepare-wikidata.mjs):
 *   cities(qid, name, country_iso2, country, admin1, population, lat, lon,
 *          elevation_m, timezone, wikipedia)
 *   countries(iso2, iso3, name, capital, continent, population, area_km2,
 *             calling_codes, currency_codes, tlds)
 *   meta(key, value) -- the provenance and caveat rows DB_META is built from.
 *
 * Caveats worth knowing before writing a query against this schema:
 *  - `admin1` is the immediate P131 parent, so it can be a county, a
 *    borough, or a metro region rather than a first level administrative
 *    division. Chicago's row reports "Cook County".
 *  - `timezone` is recorded for only a slice of settlements. A city in a
 *    country with exactly one time zone inherits that zone; a city in a
 *    multi zone country is left NULL rather than guessed.
 *  - A metropolitan area (Greater Tokyo Area, Jabodetabek) is its own row
 *    and can outrank the city it contains by population, so "largest
 *    cities" queries mix true cities with metro areas by design.
 */

/** Public path the panel fetches the pre-built database from. */
export const DB_PATH = "/data/wikidata-cities.sqlite";

/** Provenance and shape of the bundled snapshot, read from its own meta table. */
export const DB_META = {
  /** Date the sqlite snapshot was last rebuilt (from its own meta table). */
  builtAt: "2026-08-23",
  license: "CC0 1.0 (Wikidata)",
  source: "https://query.wikidata.org/sparql",
  tables: ["cities", "countries", "meta"] as const,
  counts: {
    cities: 7622,
    countries: 255,
  },
  /** Cities are only included once their population passes this floor. */
  populationThreshold: 100000,
  /** Size of the committed sqlite file on disk, for the "Size" field. */
  sizeBytes: 1298432,
  notes: [
    "admin1 is the immediate administrative parent (Wikidata P131), so it can be a county, a borough, or a metro region rather than a first level division.",
    "timezone is recorded for only some settlements; a city inherits its country's zone only when that country has exactly one, so cities in multi zone countries are left blank rather than guessed.",
    "A city and its containing metro area can both appear as separate rows, and the metro area can outrank the city itself by population.",
  ],
} as const;

export interface CuratedQuery {
  label: string;
  sql: string;
  description: string;
}

/**
 * Ready-made queries for the sqlite viewer panel. Two use named bind
 * parameters, documented in their own description: :iso2 for an ISO 3166-1
 * alpha-2 country code, :lat and :lon for a point in decimal degrees.
 */
export const CURATED_QUERIES: CuratedQuery[] = [
  {
    label: "Largest cities worldwide",
    sql: "SELECT name, country, population FROM cities ORDER BY population DESC LIMIT 25",
    description: "The 25 most populous settlements in the dataset, largest first.",
  },
  {
    label: "Largest cities in one country",
    sql: "SELECT name, admin1, population FROM cities WHERE country_iso2 = :iso2 ORDER BY population DESC LIMIT 25",
    description:
      "Largest cities within a single country. Bind :iso2 to an ISO 3166-1 alpha-2 code, for example 'JP'.",
  },
  {
    label: "Most city-dense countries",
    sql: "SELECT c.name AS country, COUNT(ci.qid) AS city_count, c.area_km2, ROUND(COUNT(ci.qid) / c.area_km2, 4) AS cities_per_km2 FROM countries c JOIN cities ci ON ci.country_iso2 = c.iso2 WHERE c.area_km2 IS NOT NULL GROUP BY c.iso2 ORDER BY cities_per_km2 DESC LIMIT 25",
    description:
      "Countries with the most cities per square kilometer, joining the cities and countries tables on the ISO alpha-2 code.",
  },
  {
    label: "Highest cities by elevation",
    sql: "SELECT name, country, elevation_m FROM cities WHERE elevation_m IS NOT NULL ORDER BY elevation_m DESC LIMIT 25",
    description: "Cities with the highest recorded elevation above sea level.",
  },
  {
    label: "Northernmost cities",
    sql: "SELECT name, country, lat FROM cities ORDER BY lat DESC LIMIT 25",
    description: "Cities closest to the North Pole by latitude.",
  },
  {
    label: "Southernmost cities",
    sql: "SELECT name, country, lat FROM cities ORDER BY lat ASC LIMIT 25",
    description: "Cities closest to the South Pole by latitude.",
  },
  {
    label: "City population by continent",
    sql: "SELECT co.continent, SUM(ci.population) AS total_population, COUNT(ci.qid) AS city_count FROM cities ci JOIN countries co ON co.iso2 = ci.country_iso2 WHERE co.continent IS NOT NULL GROUP BY co.continent ORDER BY total_population DESC",
    description:
      "Summed city population and city count per continent, joining cities to countries.",
  },
  {
    label: "Cities sharing a name",
    sql: "SELECT name, COUNT(*) AS occurrences FROM cities GROUP BY name HAVING COUNT(*) > 1 ORDER BY occurrences DESC LIMIT 25",
    description: "Names that appear on more than one city row, most repeated first.",
  },
  {
    label: "Capital cities by population",
    sql: "SELECT ci.name, co.name AS country, ci.population FROM cities ci JOIN countries co ON co.iso2 = ci.country_iso2 AND ci.name = co.capital ORDER BY ci.population DESC LIMIT 25",
    description: "National capitals that also appear in the cities table, largest first.",
  },
  {
    label: "Nearest cities to a point",
    sql: "SELECT name, country, lat, lon, population FROM cities WHERE lat BETWEEN :lat - 2 AND :lat + 2 AND lon BETWEEN :lon - 2 AND :lon + 2 ORDER BY ((lat - :lat) * (lat - :lat) + (lon - :lon) * (lon - :lon)) ASC LIMIT 25",
    description:
      "Cities within roughly 2 degrees of a point, nearest first by a flat-earth approximation good enough at this scale. Bind :lat and :lon to decimal degrees; the bounding box keeps the query fast without a spatial index.",
  },
];

/** Describes the bundled database for the stateless API; runs no SQL itself. */
export function run(_input: undefined, _opts?: Record<string, unknown>): Record<string, string> {
  return {
    "Database file": DB_PATH,
    Tables: DB_META.tables.join(", "),
    Cities: `${DB_META.counts.cities.toLocaleString("en-US")} settlements with population over ${DB_META.populationThreshold.toLocaleString("en-US")}`,
    Countries: `${DB_META.counts.countries.toLocaleString("en-US")} countries and territories, joinable on the ISO alpha-2 code`,
    Size: formatBytes(DB_META.sizeBytes),
    License: DB_META.license,
    "Snapshot built": DB_META.builtAt,
    "Refresh script": "scripts/prepare-wikidata.mjs",
    "Curated queries": `${CURATED_QUERIES.length} ready-made queries: ${CURATED_QUERIES.map((q) => q.label).join(", ")}.`,
    Notes: DB_META.notes.join(" "),
  };
}

export default { run } satisfies ToolLogic<
  undefined,
  Record<string, string>,
  Record<string, unknown>
>;
