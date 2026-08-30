import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "isotope-abundance-lookup",
  icon: "TestTube",
  name: "Isotope Abundance Lookup",
  description:
    "Natural isotopes, abundance percentages and atomic mass contribution for any element, with the average mass checked against the published standard.",
  category: "Chemistry",
  keywords: [
    "isotope abundance calculator",
    "natural isotopes of an element",
    "relative atomic mass lookup",
    "isotopic composition table",
    "average atomic mass calculator",
    "isotope by mass search",
  ],
  searchTerms: [
    "nist isotope table",
    "iupac standard atomic weight",
    "abundance weighted average",
    "carbon 13 abundance",
    "isotope mass number",
    "isotope neutron count",
    "element atomic mass",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Search by",
      default: "auto",
      options: [
        {
          value: "auto",
          label: "Auto detect",
          synonyms: ["automatic", "guess", "either"],
        },
        {
          value: "element",
          label: "Element (symbol, name or atomic number)",
          synonyms: ["symbol", "name", "atomic number", "whole element"],
        },
        {
          value: "mass",
          label: "Exact relative atomic mass",
          synonyms: [
            "mass search",
            "search by mass",
            "unified atomic mass units",
            "reverse lookup",
          ],
        },
      ],
    },
    {
      kind: "number",
      id: "massTolerance",
      label: "Mass search tolerance (u)",
      default: 0.1,
      min: 0.0001,
      max: 5,
      step: 0.01,
    },
    {
      kind: "number",
      id: "decimals",
      label: "Decimal places",
      default: 6,
      min: 0,
      max: 10,
      step: 1,
    },
  ],
  examples: [
    { label: "Carbon, all natural isotopes", input: "C" },
    { label: "A single isotope, carbon 13", input: "C-13" },
    {
      label: "Search by exact mass",
      input: "34.96885",
      opts: { mode: "mass", massTolerance: "0.01" },
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Looks up every naturally occurring isotope of an element, its relative atomic mass, its fractional abundance, and how much of the element's average atomic mass it contributes. The average is computed live from the abundances rather than looked up, then compared against the published IUPAC standard atomic weight so the arithmetic is visible. A mass search runs the lookup in reverse, finding which isotope of which element has a relative atomic mass near the number you typed.",
    how: "Type an element symbol, name or atomic number, such as Fe, iron or 26, to see all of its natural isotopes at once. Add a mass number, as C-13 or 13C, to focus on one isotope. Switch the mode to search by exact mass instead, and widen the tolerance if nothing turns up close enough.",
    why: "Most isotope references either hide the arithmetic behind a single averaged number or bury the table in a PDF. This one shows every isotope's contribution to the average side by side with the IUPAC standard weight, cites the NIST source it was built from, and runs entirely in your browser, so your inputs never leave your device.",
    faq: [
      {
        q: "Where does the isotope data come from?",
        a: "The NIST Physical Measurement Laboratory database, Atomic Weights and Isotopic Compositions with Relative Atomic Masses (NIST Standard Reference Database 144), which republishes the IUPAC Commission on Isotopic Abundances and Atomic Weights evaluations. It covers the 288 isotopes across 84 elements that have a measured natural abundance.",
      },
      {
        q: "Why does the computed average not exactly match the standard atomic weight?",
        a: "For most elements they agree to five or six figures, since both come from the same abundances. Fourteen elements, lithium being the extreme case, have isotopic compositions that measurably vary between natural sources, so IUPAC publishes an interval rather than one number; the comparison here is against the interval's midpoint, which is why lithium sits about 0.4% off.",
      },
      {
        q: "Why do some elements, like technetium, have no results?",
        a: "Technetium, promethium and almost everything past bismuth has no naturally occurring isotope with a measured abundance: every isotope of those elements is made artificially or occurs only in trace amounts from radioactive decay chains, so there is nothing to average.",
      },
    ],
  },
};
