import { COUNTRIES } from "../_generated/wikidata-countries";
import { AIRPORTS, WIKIDATA_META, type Airport } from "../_generated/wikidata-airports";
import { ToolError, type ToolLogic } from "../types";

/**
 * Airport code lookup: one search box over the 9,073 IATA code holders in
 * the Wikidata snapshot, plus a "code to code" mode for great circle
 * distance and initial bearing between two of them.
 *
 * The subject set is wider than "airport": aerodromes, air bases and
 * heliports are included because plenty of real IATA codes only exist on
 * those entity types. Three quirks worth knowing before reading further,
 * documented for users in the page FAQ:
 *  - LON and PAR are the Wikidata items for London and Paris themselves, so
 *    those two rows have no ICAO code and describe the city, not one field.
 *  - NYC is absent. New York City's Wikidata item carries no IATA code.
 *  - AAL resolves to "Aalborg Air Base" rather than the civil airport,
 *    because the dedup keeps whichever entity has more filled fields.
 *
 * Distance and bearing use a plain spherical haversine on the IUGG mean
 * earth radius, which is what every other geo tool in this app quotes, kept
 * as a small local copy rather than an import so this file stays a
 * self-contained pure module.
 */

const SPHERE_RADIUS_KM = 6371.0088;
const KM_PER_MILE = 1.609344;
const KM_PER_NAUTICAL_MILE = 1.852;

const toRad = (d: number): number => (d * Math.PI) / 180;
const toDeg = (r: number): number => (r * 180) / Math.PI;
const wrap360 = (d: number): number => ((d % 360) + 360) % 360;

export interface LatLon {
  lat: number;
  lon: number;
}

/** Great circle distance in kilometers on a sphere of mean earth radius. */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * SPHERE_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial great circle bearing in degrees clockwise from true north. */
export function initialBearing(a: LatLon, b: LatLon): number {
  const p1 = toRad(a.lat);
  const p2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLon);
  return wrap360(toDeg(Math.atan2(y, x)));
}

const COMPASS_POINTS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];

/** Nearest of the 16 compass rose points to a bearing in degrees. */
export function compassPoint(deg: number): string {
  const idx = Math.round(wrap360(deg) / 22.5) % 16;
  return COMPASS_POINTS[idx]!;
}

/** Degrees minutes seconds, for example 41°58'43.0"N or 87°54'17.0"W. */
export function toDms(deg: number, positiveHemi: string, negativeHemi: string): string {
  const hemi = deg >= 0 ? positiveHemi : negativeHemi;
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const minFull = (abs - d) * 60;
  const m = Math.floor(minFull);
  const s = (minFull - m) * 60;
  return `${d}°${m}′${s.toFixed(1)}″${hemi}`;
}

export type AirportMatchField = "iata" | "icao" | "name" | "city";

export interface AirportMatch {
  airport: Airport;
  /** Higher is better. IATA exact 1000, ICAO exact 950, down to 230 for a loose city substring. */
  score: number;
  matchedOn: AirportMatchField;
}

function byNameThenIata(a: Airport, b: Airport): number {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an < bn) return -1;
  if (an > bn) return 1;
  return a.iata < b.iata ? -1 : a.iata > b.iata ? 1 : 0;
}

function scoreOne(a: Airport, q: string): AirportMatch | undefined {
  const iata = a.iata.toLowerCase();
  const icao = a.icao?.toLowerCase();
  const name = a.name.toLowerCase();
  const city = a.city?.toLowerCase();

  if (iata === q) return { airport: a, score: 1000, matchedOn: "iata" };
  if (icao === q) return { airport: a, score: 950, matchedOn: "icao" };
  if (name === q) return { airport: a, score: 700, matchedOn: "name" };
  if (city === q) return { airport: a, score: 650, matchedOn: "city" };
  if (name.startsWith(q)) return { airport: a, score: 500, matchedOn: "name" };
  if (city?.startsWith(q)) return { airport: a, score: 480, matchedOn: "city" };
  if (name.includes(q)) return { airport: a, score: 250, matchedOn: "name" };
  if (city?.includes(q)) return { airport: a, score: 230, matchedOn: "city" };
  return undefined;
}

/**
 * Ranked matches for an IATA code, ICAO code, airport name, or city. Best
 * first, ties broken alphabetically by name then IATA code.
 */
export function findAirport(text: string, limit = 10): AirportMatch[] {
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  const q = raw.toLowerCase();

  const out: AirportMatch[] = [];
  for (const a of AIRPORTS) {
    const hit = scoreOne(a, q);
    if (hit) out.push(hit);
  }
  out.sort((x, y) => y.score - x.score || byNameThenIata(x.airport, y.airport));
  return out.slice(0, Math.max(0, limit));
}

/**
 * Looser suggestions for a query that matched nothing. Shortens each word of
 * the query one letter at a time down to three and returns the first stem
 * that turns up any airport name. Only ever runs on the error path.
 */
export function suggestions(text: string, limit = 3): Airport[] {
  const words = String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
  for (const word of words) {
    for (let length = word.length; length >= 3; length--) {
      const stem = word.slice(0, length);
      const hits = AIRPORTS.filter((a) => a.name.toLowerCase().includes(stem));
      if (hits.length) return hits.sort(byNameThenIata).slice(0, limit);
    }
  }
  return [];
}

export function wikipediaUrl(a: Airport): string | undefined {
  if (!a.wikipedia) return undefined;
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(a.wikipedia.replace(/ /g, "_"))}`;
}

function countryName(iso2?: string): string {
  if (!iso2) return "Not recorded";
  const c = COUNTRIES.find((c) => c.iso2 === iso2);
  return c ? c.name : iso2;
}

function label(a: Airport): string {
  return `${a.name} (${a.iata})`;
}

/** Resolves one query to a single airport, throwing an actionable error on no match or a tie. */
export function resolveAirport(text: string): Airport {
  const raw = String(text ?? "").trim();
  if (!raw)
    throw new ToolError(
      "empty-input",
      "No airport to look up.",
      'Type an IATA or ICAO code like "ORD", an airport name, or a city.',
    );

  const matches = findAirport(raw, 10);
  if (!matches.length) {
    const guesses = suggestions(raw);
    throw new ToolError(
      "no-match",
      `Nothing matches "${raw}".`,
      guesses.length
        ? `Did you mean ${guesses.map(label).join(", ")}?`
        : "Try an IATA code, an ICAO code, an airport name, or a city.",
    );
  }

  const top = matches[0]!;
  const runnerUp = matches[1];
  const tied =
    runnerUp !== undefined &&
    runnerUp.score === top.score &&
    runnerUp.airport.iata !== top.airport.iata;
  if (tied)
    throw new ToolError(
      "ambiguous",
      `"${raw}" matches ${matches.length === 10 ? "10 or more" : matches.length} airports equally well.`,
      `Try one of ${matches
        .slice(0, 3)
        .map((m) => label(m.airport))
        .join(", ")}.`,
    );

  return top.airport;
}

const SOURCE_NOTE = `Wikidata, CC0 1.0. Snapshot built ${WIKIDATA_META.builtAt.slice(0, 10)}.`;

/** The full data sheet for one airport, ready for the record renderer. */
export function describeAirport(a: Airport): Record<string, string> {
  const out: Record<string, string> = { Name: a.name };
  out["IATA code"] = a.iata;
  out["ICAO code"] = a.icao ?? "Not recorded";
  out["City"] = a.city ?? "Not recorded";
  out["Country"] = countryName(a.country);
  out["Coordinates (decimal)"] =
    a.lat !== undefined && a.lon !== undefined
      ? `${a.lat.toFixed(4)}, ${a.lon.toFixed(4)}`
      : "Not recorded";
  out["Coordinates (DMS)"] =
    a.lat !== undefined && a.lon !== undefined
      ? `${toDms(a.lat, "N", "S")} ${toDms(a.lon, "E", "W")}`
      : "Not recorded";
  out["Elevation"] =
    a.elevationM !== undefined
      ? `${a.elevationM} m (${Math.round(a.elevationM * 3.28084)} ft)`
      : "Not recorded";
  out["Time zone"] = a.timeZone ?? "Not recorded";
  const wiki = wikipediaUrl(a);
  if (wiki) out["Wikipedia"] = wiki;
  if (!a.icao)
    out["Note"] =
      "No ICAO code recorded. This IATA code may belong to a city or metro area item rather than a single airport.";
  out["Source"] = SOURCE_NOTE;
  return out;
}

/** Splits "ORD to LHR" or two newline separated queries into a pair; undefined for a single query. */
export function splitPairQuery(raw: string): [string, string] | undefined {
  const lines = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length === 2) return [lines[0]!, lines[1]!];
  if (lines.length === 1) {
    const m = /^(.+?)\s+to\s+(.+)$/i.exec(lines[0]!);
    if (m) return [m[1]!.trim(), m[2]!.trim()];
  }
  if (lines.length > 2) return [lines[0]!, lines[1]!];
  return undefined;
}

function requireCoordinates(a: Airport): LatLon {
  if (a.lat === undefined || a.lon === undefined)
    throw new ToolError(
      "missing-coordinates",
      `${label(a)} has no recorded coordinates, so a distance cannot be computed.`,
      "Try a different airport for that side of the pair.",
    );
  return { lat: a.lat, lon: a.lon };
}

/** Both airports plus great circle distance and initial bearing between them. */
export function describePair(a: Airport, b: Airport): Record<string, string> {
  const p1 = requireCoordinates(a);
  const p2 = requireCoordinates(b);
  const km = haversineKm(p1, p2);
  const mi = km / KM_PER_MILE;
  const nmi = km / KM_PER_NAUTICAL_MILE;
  const bearing = initialBearing(p1, p2);

  return {
    "Airport 1": label(a),
    "Airport 2": label(b),
    "Distance (km)": km.toFixed(1),
    "Distance (mi)": mi.toFixed(1),
    "Distance (nmi)": nmi.toFixed(1),
    "Initial bearing": `${bearing.toFixed(1)}° (${compassPoint(bearing)})`,
    Source: SOURCE_NOTE,
  };
}

export function run(input: string, _opts?: Record<string, unknown>): Record<string, string> {
  const raw = String(input ?? "").trim();
  if (!raw)
    throw new ToolError(
      "empty-input",
      "No airport to look up.",
      'Type an IATA or ICAO code like "ORD", an airport or city name, or two codes like "ORD to LHR" for distance and bearing.',
    );

  const pair = splitPairQuery(raw);
  if (pair) {
    const [q1, q2] = pair;
    return describePair(resolveAirport(q1), resolveAirport(q2));
  }

  return describeAirport(resolveAirport(raw));
}

export default { run } satisfies ToolLogic<string, Record<string, string>, Record<string, unknown>>;
