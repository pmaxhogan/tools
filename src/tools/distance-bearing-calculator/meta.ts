import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "distance-bearing-calculator",
  matrixSlug: "geo-calc",
  icon: "Compass",
  name: "Distance and Bearing Calculator",
  description:
    "Great circle and WGS84 distance, initial and final bearing, midpoint, and magnetic declination between coordinates.",
  category: "Geo",
  keywords: [
    "distance between coordinates",
    "bearing calculator",
    "great circle distance",
    "magnetic declination calculator",
    "haversine calculator",
    "vincenty distance",
    "midpoint between two coordinates",
  ],
  searchTerms: [
    "lat long distance",
    "how far apart are two points",
    "azimuth between two points",
    "compass heading calculator",
    "magnetic variation",
    "true north vs magnetic north",
    "nautical miles between coordinates",
    "world magnetic model",
    "destination from bearing and distance",
    "geodesic distance",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "units",
      label: "Distance unit",
      default: "km",
      options: [
        {
          value: "km",
          label: "Kilometres",
          synonyms: ["km", "kilometers", "kilometres", "metric"],
        },
        {
          value: "mi",
          label: "Miles",
          synonyms: ["mi", "statute miles", "imperial", "land miles"],
        },
        {
          value: "nmi",
          label: "Nautical miles",
          synonyms: ["nmi", "nm", "marine", "aviation", "sailing", "knots"],
        },
        { value: "m", label: "Metres", synonyms: ["m", "meters", "metres", "survey"] },
      ],
    },
    {
      kind: "boolean",
      id: "magnetic",
      label: "Show magnetic declination and magnetic bearing",
      default: true,
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Works out the distance and bearing between coordinates two ways at once: the haversine great circle on a sphere of mean radius 6371.0088 km, and Vincenty's geodesic on the WGS84 ellipsoid, with the difference between them spelled out. It also gives the initial and final true bearings, the midpoint, and the magnetic declination at each end from the World Magnetic Model 2025, so you get the magnetic bearing you would actually steer. Give three or more points and it becomes a route with per leg distances, bearings and a total. Give a line like from 40.7,-74 bearing 45 distance 100km and it solves the other direction, telling you where you end up.",
    how: "Paste one coordinate per line, or separate them with semicolons. Decimal degrees, degrees and decimal minutes, and full degrees minutes seconds all work, with or without N, S, E and W letters. Add a line like on 2026-08-19 to price the declination for a specific date instead of today, and pick kilometres, miles, nautical miles or metres from the unit menu. Every row has its own copy button and the URL updates as you type, so you can share the exact result.",
    why: "Most distance calculators give you one number on a sphere and stop there, and the ones that add magnetic declination usually ask you to hit a government API for it. This page runs the full World Magnetic Model in your browser, validated against the official NOAA test value table, alongside a real Vincenty solution rather than a spherical approximation. There are no ads, no sign up, no daily limits, and your files and inputs never leave your device.",
    faq: [
      {
        q: "Why are the sphere and ellipsoid distances different?",
        a: "The haversine formula treats the earth as a perfect sphere, which is simple and fast but off by up to about 0.3 percent because the earth is flatter at the poles. Vincenty's inverse formula solves the same problem on the WGS84 ellipsoid, the shape GPS actually uses, and is accurate to under a millimetre. For New York to London the sphere gives 5570.2 km and the ellipsoid gives 5585.2 km, a 15 km gap. Use the ellipsoid figure for anything that matters and the sphere figure when you just want a quick sense of scale.",
      },
      {
        q: "What is magnetic declination and which model is used here?",
        a: "Magnetic declination, also called variation, is the angle between true north and the direction a compass needle points at your position. It changes with location and drifts year by year, so a compass bearing is only useful once you know it. This tool uses the World Magnetic Model 2025, the model jointly produced by NOAA and the British Geological Survey, valid from 2025.0 to 2030.0, with the full degree 12 coefficient set and its secular variation. Declination is reported east positive, so the magnetic bearing is the true bearing minus the declination.",
      },
      {
        q: "How accurate are these numbers?",
        a: "The Vincenty distances match Karney's GeographicLib to well under a millimetre for ordinary point pairs, and the test suite checks that. Vincenty does not converge for nearly antipodal points, which is a known limit of the algorithm, and in that case the sphere value is shown with a clear note instead of a wrong number. The magnetic model is checked against every row of the official NOAA WMM2025 test value table and agrees to better than 0.005 degrees. The model itself has a stated accuracy of about 1 degree of declination at sea level for most of the globe, and much worse near the magnetic poles where declination changes fast.",
      },
    ],
  },
};
