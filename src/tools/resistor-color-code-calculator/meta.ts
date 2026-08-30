import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "resistor-color-code-calculator",
  matrixSlug: "resistor",
  icon: "Cable",
  name: "Resistor Color Code Calculator",
  description:
    "Decode 3, 4, 5, and 6 band resistor color codes into resistance and tolerance, or encode a target resistance into bands.",
  category: "Electronics",
  keywords: [
    "resistor color code calculator",
    "resistor color code",
    "4 band resistor",
    "5 band resistor calculator",
    "resistor band colors",
    "read resistor value",
  ],
  searchTerms: [
    "resistor color chart",
    "resistor calculator",
    "e12 e24 e96 series",
    "resistor tolerance colors",
    "resistor temperature coefficient",
    "band color to ohms",
    "ohms to band colors",
    "4k7 resistor notation",
    "resistor stripe calculator",
    "resistor band colour meaning",
    "what resistor do i need",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Mode",
      default: "decode",
      options: [
        {
          value: "decode",
          label: "Decode colors to value",
          synonyms: [
            "read resistor",
            "colors to value",
            "decode bands",
            "what value is this resistor",
          ],
        },
        {
          value: "encode",
          label: "Encode value to colors",
          synonyms: ["value to colors", "encode bands", "find bands", "generate color code"],
        },
      ],
    },
    {
      kind: "select",
      id: "bands",
      label: "Band count (encode)",
      default: "4",
      options: [
        { value: "4", label: "4 band", synonyms: ["four band", "4-band", "standard resistor"] },
        { value: "5", label: "5 band", synonyms: ["five band", "5-band", "precision resistor"] },
        {
          value: "6",
          label: "6 band",
          synonyms: ["six band", "6-band", "temperature coefficient"],
        },
      ],
    },
    {
      kind: "select",
      id: "tolerance",
      label: "Tolerance (encode)",
      default: "5",
      options: [
        {
          value: "5",
          label: "5% (gold)",
          synonyms: ["five percent", "standard tolerance", "gold band"],
        },
        { value: "1", label: "1% (brown)", synonyms: ["one percent", "metal film", "precision"] },
        { value: "2", label: "2% (red)", synonyms: ["two percent"] },
        { value: "0.5", label: "0.5% (green)", synonyms: ["half percent", "point five percent"] },
        { value: "0.25", label: "0.25% (blue)", synonyms: ["quarter percent"] },
        { value: "0.1", label: "0.1% (violet)", synonyms: ["tenth percent", "high precision"] },
        { value: "10", label: "10% (silver)", synonyms: ["ten percent"] },
        {
          value: "20",
          label: "20% (no band)",
          synonyms: ["twenty percent", "no tolerance band", "three band"],
        },
      ],
    },
    {
      kind: "select",
      id: "tempco",
      label: "Temperature coefficient (6-band)",
      default: "100",
      options: [
        { value: "100", label: "100 ppm/K (brown)", synonyms: ["100ppm", "brown tempco"] },
        { value: "50", label: "50 ppm/K (red)", synonyms: ["50ppm", "red tempco"] },
        { value: "15", label: "15 ppm/K (orange)", synonyms: ["15ppm", "orange tempco"] },
        { value: "25", label: "25 ppm/K (yellow)", synonyms: ["25ppm", "yellow tempco"] },
        { value: "10", label: "10 ppm/K (blue)", synonyms: ["10ppm", "blue tempco"] },
        {
          value: "5",
          label: "5 ppm/K (violet)",
          synonyms: ["5ppm", "violet tempco", "high precision tempco"],
        },
      ],
    },
  ],
  examples: [
    {
      label: "Decode 4 band resistor",
      input: "brown green red gold",
      opts: { mode: "decode" },
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Reads 3, 4, 5, or 6 band resistor color codes into a resistance, tolerance, valid range, and temperature coefficient, or goes the other way and turns a target resistance into the right band colors. Every result also checks the value against the E12, E24, and E96 standard series so you know if it is a stock part or a rounded approximation.",
    how: 'For decoding, switch to that mode and type the band colors in order, separated by spaces, commas, or dashes, like "yellow violet red gold". For encoding, switch modes and type a target value like "4.7k", "220", or shorthand like "4k7", then pick a band count, tolerance, and, for 6-band, a temperature coefficient. When a value cannot be represented exactly with the chosen band count, the result notes the nearest value that can.',
    why: "Most resistor color code sites are click-through calculators built around one direction, one band count, or a fixed tolerance list, and few check the result against real E-series parts. This one reads and writes 3 through 6 bands, reports standard series membership automatically, and your inputs never leave your device.",
    faq: [
      {
        q: "Which end of the resistor do I start reading from?",
        a: "Read from the end where the bands are grouped closely together. The tolerance band, usually gold or silver, sits by itself with a wider gap before it, and gold or silver never appears as a digit band, so if the far band is gold or silver you are already reading in the right direction.",
      },
      {
        q: "What does a marking like 4k7 or 6R8 mean?",
        a: "It is shorthand that replaces the decimal point with the unit letter so it survives poor print quality: 4k7 means 4.7 kilo ohms and 6R8 means 6.8 ohms. This tool accepts that notation directly in encode mode.",
      },
      {
        q: "Why use a 5 or 6 band resistor instead of 4 band?",
        a: "A 4-band code only encodes two significant digits, which is not precise enough for a 1% or tighter tolerance part. A 5-band code adds a third significant digit for precision resistors, and a 6-band code adds a temperature coefficient band on top of that for parts whose stability over temperature matters.",
      },
    ],
  },
};
