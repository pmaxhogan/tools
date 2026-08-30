import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "wikidata-cities-database",
  icon: "Database",
  name: "Wikidata Cities Database",
  description:
    "Browse and query a self-contained SQLite database of 7,622 world cities and 255 countries with curated starting queries.",
  category: "Geo",
  keywords: [
    "cities database",
    "sqlite cities",
    "world cities sql",
    "cities by population",
    "sql query world cities",
    "offline cities database",
  ],
  searchTerms: [
    "sqlite viewer preloaded",
    "run sql on cities",
    "world city data offline",
    "largest cities query",
    "cities per country",
    "population by continent sql",
    "nearest city to coordinates",
    "city elevation database",
    "explore wikidata cities",
    "geography database sql",
  ],
  input: "none",
  output: "application/json",
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "A 1.2 MB SQLite database with every settlement over 100,000 people that Wikidata records (7,622 cities) joined to a 255 row countries table, plus ten curated queries covering the largest cities overall and by country, the most city-dense countries, elevation and latitude extremes, population by continent, repeated city names, capitals, and a nearest-city bounding box search. The whole file downloads once and every query then runs locally against it.",
    how: "Open the tool to load the bundled database, pick a curated query to run it as-is or edit it, or write your own SQL against the cities, countries, and meta tables. Results render as a table you can page through, and the query itself lives in the URL so a link reproduces exactly what you ran.",
    why: "Getting a queryable cities dataset usually means signing up for an API with a request quota, or scraping a table out of a Wikipedia page yourself. This ships the whole database as one file, answers instantly with no request limit, works offline after the first load, and never sends a query anywhere.",
    faq: [
      {
        q: "Where does the data come from, and can I trust the population figures?",
        a: "Wikidata, released under CC0 1.0. This is a dated snapshot rebuilt on 2026-08-23, not a live feed; that date is also recorded in the database's own meta table. Population figures come from whatever source Wikidata's editors most recently recorded for that settlement, which varies in age and methodology from city to city.",
      },
      {
        q: "Why do some cities show no time zone?",
        a: "Wikidata records a time zone for only a share of settlements. A city in a country with exactly one time zone inherits that zone; a city in a multi zone country such as the United States is left blank rather than guessed.",
      },
      {
        q: "Why does a metro area like Greater Tokyo Area outrank the city it contains?",
        a: 'Metropolitan areas are included as their own rows alongside the cities within them, and a metro area\'s population is naturally larger than any single city inside it. A "largest cities" query mixes both by design; filter on admin1 or the name if you want cities only.',
      },
    ],
  },
};
