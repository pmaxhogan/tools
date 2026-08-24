import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "airport-code-lookup",
  icon: "MapPin",
  name: "Airport Code Lookup",
  description:
    "Look up an airport by IATA or ICAO code, name, or city, or enter two to get the great circle distance and bearing.",
  category: "Geo",
  keywords: [
    "airport code lookup",
    "iata code lookup",
    "icao code lookup",
    "airport distance calculator",
    "airport name lookup",
    "flight distance calculator",
  ],
  searchTerms: [
    "three letter airport code",
    "four letter airport code",
    "what airport is this code",
    "airport by city",
    "airport coordinates",
    "airport elevation lookup",
    "airport time zone",
    "great circle distance between airports",
    "distance between two airports",
    "initial bearing between airports",
    "flight bearing calculator",
    "nautical miles between airports",
  ],
  input: "text/plain",
  output: "application/json",
  examples: [
    { label: "Single airport", input: "ORD" },
    { label: "Distance and bearing", input: "ORD to LHR" },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: 'Searches 9,073 IATA code holders by IATA code, ICAO code, airport name, or city, and shows the name, codes, city, country, coordinates in decimal and DMS, elevation, and time zone. Enter two codes separated by "to", or on two lines, to get the great circle distance in kilometers, miles, and nautical miles plus the initial compass bearing.',
    how: 'Type a code like "ORD" or a name or city, and the best match opens right away. For distance and bearing, type two codes like "ORD to LHR". When a query fits several airports equally well, such as a city with more than one, you get the candidates by name so you can pick one.',
    why: "Most airport code sites are built for travel booking, not for a quick lookup, and bury the coordinates and time zone behind ads. This is a plain search that answers in one query, computes distance and bearing locally, works offline after the first visit, and never sends what you typed anywhere.",
    faq: [
      {
        q: "Where does the data come from?",
        a: "Wikidata, released under CC0 1.0. This is a dated snapshot rebuilt on 2026-08-23, not a live feed, and the subject set is every entity carrying an IATA airport code, which is wider than airports alone and also covers aerodromes, air bases, and heliports, since real IATA codes exist on all of those.",
      },
      {
        q: "Why do LON and PAR show no city or ICAO code, and why is NYC missing entirely?",
        a: 'LON and PAR are the Wikidata items for the cities of London and Paris themselves, not any single airport, so they carry no ICAO code and their coordinates describe the city center. NYC is absent because New York City\'s Wikidata item carries no IATA code at all. Metro codes like these are not modeled consistently in the source data, so do not rely on one meaning "every airport in this city."',
      },
      {
        q: "Why does AAL point to an air base instead of a passenger airport?",
        a: 'A few IATA codes are shared by a civil airport and a military field in Wikidata, and the snapshot keeps whichever entity carries more complete data. AAL resolves to "Aalborg Air Base" for that reason rather than Aalborg Airport.',
      },
    ],
  },
};
