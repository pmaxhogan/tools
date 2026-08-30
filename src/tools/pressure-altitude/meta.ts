import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "pressure-altitude",
  matrixSlug: "pressure-altitude-calculator",
  icon: "Gauge",
  name: "Pressure Altitude Calculator",
  description:
    "Pressure altitude, density altitude, altimeter setting and air density from station pressure, elevation and temperature, plus the reverse ISA lookup from altitude.",
  category: "Weather & Earth",
  keywords: [
    "pressure altitude calculator",
    "density altitude calculator",
    "altimeter setting calculator",
    "isa standard atmosphere calculator",
    "air density calculator",
    "standard atmosphere table",
  ],
  searchTerms: [
    "icao standard atmosphere",
    "us standard atmosphere 1976",
    "qnh estimate",
    "hot and high density altitude",
    "field elevation pressure altitude",
    "tropopause temperature",
  ],
  input: "none",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Direction",
      default: "forward",
      ui: "segmented",
      options: [
        {
          value: "forward",
          label: "From station pressure",
          synonyms: ["pressure to altitude", "field observation", "forward"],
        },
        {
          value: "reverse",
          label: "From altitude",
          synonyms: ["altitude to pressure", "isa lookup", "reverse", "standard atmosphere table"],
        },
      ],
    },
    {
      kind: "number",
      id: "stationPressure",
      label: "Station pressure",
      default: 1013.25,
      min: 1,
      max: 1100,
      step: 0.01,
    },
    {
      kind: "number",
      id: "elevation",
      label: "Field elevation",
      default: 0,
      min: 0,
      max: 36000,
      step: 1,
    },
    {
      kind: "number",
      id: "temperature",
      label: "Outside air temperature",
      default: 15,
      min: -90,
      max: 150,
      step: 0.1,
    },
    {
      kind: "number",
      id: "altitude",
      label: "Altitude (reverse mode)",
      default: 0,
      min: 0,
      max: 65600,
      step: 1,
    },
    {
      kind: "select",
      id: "pressureUnit",
      label: "Pressure unit",
      default: "hPa",
      ui: "segmented",
      options: [
        { value: "hPa", label: "hPa", synonyms: ["hectopascals", "millibars", "mb"] },
        { value: "inHg", label: "inHg", synonyms: ["inches of mercury"] },
        { value: "mmHg", label: "mmHg", synonyms: ["millimeters of mercury", "torr"] },
      ],
    },
    {
      kind: "select",
      id: "altitudeUnit",
      label: "Altitude unit",
      default: "m",
      ui: "segmented",
      options: [
        { value: "m", label: "meters", synonyms: ["metres", "m"] },
        { value: "ft", label: "feet", synonyms: ["ft"] },
      ],
    },
    {
      kind: "select",
      id: "temperatureUnit",
      label: "Temperature unit",
      default: "C",
      ui: "segmented",
      options: [
        { value: "C", label: "Celsius", synonyms: ["c", "centigrade"] },
        { value: "F", label: "Fahrenheit", synonyms: ["f"] },
      ],
    },
  ],
  examples: [
    {
      label: "Hot day at a mile-high field",
      opts: {
        mode: "forward",
        pressureUnit: "inHg",
        altitudeUnit: "ft",
        temperatureUnit: "F",
        stationPressure: "24.9",
        elevation: "5430",
        temperature: "95",
      },
    },
    {
      label: "Standard values at the tropopause",
      opts: { mode: "reverse", altitudeUnit: "m", altitude: "11000" },
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Converts station pressure, field elevation and outside air temperature into pressure altitude, density altitude, an estimated altimeter setting (QNH) and actual air density, all against the ICAO / US Standard Atmosphere 1976 model. Density altitude is computed exactly by inverting the standard atmosphere's density function rather than through the common 120 feet per degree rule of thumb. Switch to reverse mode to read the standard pressure, temperature and density the model predicts at any altitude from 0 to 20 km.",
    how: "In forward mode, enter the station pressure your barometer reads, the field elevation, and the outside air temperature, in whatever units you have them. In reverse mode, enter just an altitude to see what the standard atmosphere predicts there, the same table every aviation weather briefing and physics textbook opens with. Every pressure, altitude and temperature is shown in both of its supported units at once.",
    why: "Pilots and flight students usually reach for two separate calculators, one for pressure altitude and a rule of thumb for density altitude; this combines both into one tool, computes density altitude as an exact inversion instead of an approximation, and adds the reverse lookup so a standard atmosphere table does not need a separate reference. It runs entirely in your browser, so your inputs never leave your device.",
    faq: [
      {
        q: "What is the difference between pressure altitude and density altitude?",
        a: "Pressure altitude only accounts for pressure: it is what an altimeter set to 1013.25 hPa (29.92 inHg) reads. Density altitude also accounts for temperature, since warm air is less dense than the standard atmosphere predicts at that pressure; it is higher than pressure altitude on a hot day and lower on a cold one, and it is what actually governs aircraft and engine performance.",
      },
      {
        q: "Why does the standard atmosphere start at 1013.25 hPa and 15 C?",
        a: "Those are the ICAO / US Standard Atmosphere 1976 sea level reference values, chosen as a fixed idealization of average conditions. Every pressure altitude, density altitude and altimeter setting calculation is defined relative to this fixed reference, not to today's actual sea level pressure anywhere.",
      },
      {
        q: "Is the altimeter setting here the same as an official METAR QNH?",
        a: "It is an estimate, computed by reducing the station pressure to sea level using the fixed ISA lapse rate at the given elevation. A real station's reported altimeter setting can use a more elaborate procedure with the station's temperature history, so treat this as a close estimate rather than an official value.",
      },
    ],
  },
};
