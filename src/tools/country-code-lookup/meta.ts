import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "country-code-lookup",
  icon: "Globe",
  name: "Country Code Lookup",
  description:
    "Look up a country by ISO code, name, calling code, or top level domain and see its full profile.",
  category: "Geo",
  keywords: [
    "country code lookup",
    "iso 3166 lookup",
    "country calling code",
    "country tld lookup",
    "iso alpha 2 lookup",
    "iso alpha 3 lookup",
  ],
  searchTerms: [
    "country abbreviation",
    "two letter country code",
    "three letter country code",
    "country dialing code",
    "phone country code",
    "country currency lookup",
    "which side of the road",
    "driving side by country",
    "plug type by country",
    "country flag emoji",
    "capital city lookup",
    "country time zone lookup",
    "country domain extension",
    "iso 3166-1 numeric",
    "country demonym",
  ],
  input: "text/plain",
  output: "application/json",
  examples: [
    { label: "By ISO code", input: "DE" },
    { label: "By calling code", input: "+49" },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Searches 255 countries and territories by ISO 3166-1 alpha-2 or alpha-3 code, numeric code, English name, official name, international calling code (with a leading plus), or top level domain (with a leading dot). The match shows codes, calling codes, currencies, TLDs, time zones, driving side, plug types, capital, continent, population, area, flag, and a Wikipedia link.",
    how: 'Type an ISO code like "DE", a name like "Germany", a calling code like "+49", or a domain like ".de" into the box. The best match opens right away. When a query fits several countries equally well, such as a shared calling code, you get the candidates by name so you can pick one.',
    why: "A country code lookup usually means digging through a Wikipedia table or an outdated ISO reference page with ads bolted on. This pulls the same public domain Wikidata into one page that answers in one search, works offline after the first visit, and never sends what you typed anywhere.",
    faq: [
      {
        q: "Where does the data come from?",
        a: "Wikidata, released under CC0 1.0, so it carries no attribution requirement. The snapshot date is shown at the bottom of every result.",
      },
      {
        q: "Why does searching a calling code sometimes ask me to pick a country?",
        a: 'Some calling codes cover several countries. Searching "+1" matches both the United States and Canada equally well, so both are offered instead of guessing.',
      },
      {
        q: "Is the data current?",
        a: 'It is a dated snapshot rebuilt from Wikidata on 2026-08-23, not a live feed. Fields Wikidata does not record for a given country, such as a missing capital or calling code, show as "Not recorded" rather than being left blank.',
      },
    ],
  },
};
