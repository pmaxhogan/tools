import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "coordinate-converter",
  matrixSlug: "coords",
  icon: "MapPin",
  name: "Coordinate Converter",
  description:
    "Convert between decimal degrees, DMS, UTM, MGRS, Plus Codes and geohashes in any direction.",
  category: "Geo",
  keywords: [
    "coordinate converter",
    "lat long to utm",
    "dms to decimal degrees",
    "mgrs converter",
    "utm to lat long",
    "decimal degrees to dms",
  ],
  searchTerms: [
    "gps coordinate converter",
    "latitude longitude converter",
    "degrees minutes seconds converter",
    "plus code converter",
    "open location code",
    "geohash converter",
    "military grid reference system",
    "nato grid reference",
    "geo uri",
    "convert map coordinates",
    "wgs84 converter",
    "distance between two coordinates",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "number",
      id: "decimals",
      label: "Decimal places",
      default: 6,
      min: 2,
      max: 8,
      step: 1,
    },
    {
      kind: "select",
      id: "mgrsPrecision",
      label: "MGRS precision",
      default: "1",
      options: [
        {
          value: "1",
          label: "1 m (10 digits)",
          synonyms: ["metre", "meter", "full precision", "ten digit", "1m"],
        },
        {
          value: "10",
          label: "10 m (8 digits)",
          synonyms: ["ten metres", "ten meters", "eight digit", "10m"],
        },
        {
          value: "100",
          label: "100 m (6 digits)",
          synonyms: ["hundred metres", "hundred meters", "six digit", "100m"],
        },
        {
          value: "1000",
          label: "1 km (4 digits)",
          synonyms: ["kilometre", "kilometer", "1000 m", "four digit", "1km"],
        },
        {
          value: "10000",
          label: "10 km (2 digits)",
          synonyms: ["ten kilometres", "ten kilometers", "10000 m", "two digit", "10km"],
        },
      ],
    },
    { kind: "boolean", id: "links", label: "Include map links", default: true },
  ],
  examples: [
    { label: "Statue of Liberty", input: "40.6892, -74.0445" },
    {
      label: "Distance between two cities",
      input: "40.7484, -73.9857; 51.5007, -0.1246",
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Reads a position written almost any way and shows it in every other notation at once. It accepts decimal degrees, degrees with minutes and seconds, degrees with decimal minutes, UTM, MGRS, Plus Codes, geohashes, geo URIs and pasted map links, then returns decimal degrees, DMS, DDM, UTM, MGRS, a Plus Code, a geohash, a geo URI and ready to open map links. The UTM and MGRS maths is WGS84 with the Kruger series, so it stays accurate to well under a centimeter and handles the southwest Norway and Svalbard zone exceptions. Give it two positions separated by a semicolon or a blank line and it adds the great circle distance and the initial bearing.",
    how: "Paste one coordinate in whatever form you already have it, such as 40.7128, -74.0060 or 40°42'46\"N 74°00'22\"W or 18TWL8395907350. Every row has its own copy button, so you can lift just the MGRS reference or just the Plus Code. Use the options to set how many decimal places the decimal degrees carry, how fine the MGRS reference should be, and whether to include map links. Hemisphere letters always win over value order, so add N, S, E or W whenever the order could be read either way.",
    why: "The usual coordinate sites split each conversion across a separate page, wrap it in ads, and post your position to a server to do arithmetic a browser can do instantly. This one does every conversion at once, offline after the first load, and your files and inputs never leave your device. It also tells you which format it recognized and how precise the input actually was, so a 10 km MGRS square is never mistaken for a meter of accuracy.",
    faq: [
      {
        q: "Why does my UTM easting differ by a meter from another site?",
        a: "Most differences come from rounding rather than from the maths. UTM values here are rounded to the nearest meter, while MGRS truncates towards the southwest corner of the cell, which is what the standard requires. That is why the same position can read 583959 in MGRS and 583959 or 583960 as a rounded UTM easting.",
      },
      {
        q: "Which value is latitude when I paste two bare numbers?",
        a: "The first one, unless a hemisphere letter says otherwise, and the output says so in a note. If the first value is outside the range of a latitude it is read as longitude instead and the note points that out. Adding N, S, E or W removes the guesswork entirely.",
      },
      {
        q: "Why will it not read my short Plus Code?",
        a: "A short code like Q2MQ+6V only makes sense next to a place name, because the missing first characters come from that place. Paste the full code instead, such as 87G7PX7V+4J, which is complete on its own and needs no reference point.",
      },
    ],
  },
};
