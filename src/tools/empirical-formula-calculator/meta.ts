import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "empirical-formula-calculator",
  icon: "Calculator",
  name: "Empirical Formula Calculator",
  description: "Turn mass percent composition into an empirical and molecular formula.",
  category: "Chemistry",
  keywords: [
    "empirical formula calculator",
    "molecular formula calculator",
    "percent composition to formula",
    "mass percent to empirical formula",
    "combustion analysis calculator",
    "percent composition calculator",
  ],
  searchTerms: [
    "mole ratio",
    "simplest whole number ratio",
    "formula from percentages",
    "elemental analysis",
    "ch2o glucose",
    "molecular formula from molar mass",
    "percentage by mass",
    "empirical formula mass",
    "simplest formula",
    "composition to formula",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Direction",
      default: "auto",
      options: [
        {
          value: "auto",
          label: "Detect from the input",
          synonyms: ["auto", "automatic", "guess", "either way"],
        },
        {
          value: "composition",
          label: "Composition to formula",
          synonyms: ["forward", "percentages to formula", "empirical"],
        },
        {
          value: "percent",
          label: "Formula to percent composition",
          synonyms: ["reverse", "backwards", "percent composition", "mass percent"],
        },
      ],
    },
    {
      kind: "number",
      id: "tolerance",
      label: "Rounding tolerance for whole number ratios",
      default: 0.1,
      min: 0.01,
      max: 0.4,
      step: 0.01,
    },
    { kind: "number", id: "decimals", label: "Decimal places", default: 4, min: 0, max: 8, step: 1 },
  ],
  examples: [
    { label: "Glucose from its percentages", input: "C: 40.0%, H: 6.7%, O: 53.3%, molarMass: 180.16" },
    { label: "Masses from a combustion analysis", input: "C: 1.20 g, H: 0.20 g, O: 1.60 g" },
    { label: "Percent composition of a formula", input: "C6H12O6" },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Turns a percent composition or a set of measured masses into moles, a mole ratio, and the empirical formula, showing every step of the working. Add the compound's molar mass and it also gives the molecular formula and how many empirical units make up one molecule. Typing a formula instead runs the calculation the other way and reports the mass percent of each element, which is what a combustion analysis result gets compared against.",
    how: "List the elements and their shares, one per line or separated by commas: \"C: 40.0%, H: 6.7%, O: 53.3%\". Masses work in place of percentages, as in \"C: 1.20 g\", and a bare number with no unit is read as a percentage. Add a line such as \"molarMass: 180.16\" to get the molecular formula. To go the other way, just type a formula like C6H12O6. The rounding tolerance option controls how far from a whole number a scaled ratio may sit, which matters for rough experimental data.",
    why: "Most empirical formula calculators only accept percentages, only accept exactly three elements, or round the mole ratio without telling you what multiplier they used. This one takes percentages or masses, any number of elements, prints the mole ratio before and after scaling, flags percentages that do not add to a hundred, and warns when the molar mass you gave is not a whole multiple of the empirical formula mass. It runs entirely in your browser, so your inputs never leave your device.",
    faq: [
      {
        q: "Why does the tool multiply the ratio by a whole number?",
        a: "Because dividing by the smallest number of moles often leaves a fraction. A ratio of 1 to 2.5 is really 2 to 5, so the ratio is multiplied by the smallest whole number from 1 to 12 that lands every element within the rounding tolerance of an integer. The result names the multiplier it used, so you can check the step by hand.",
      },
      {
        q: "My percentages add up to 97%. Is the answer wrong?",
        a: "Not necessarily, because only the relative amounts matter, and the answer is flagged rather than silently accepted. A total well below a hundred usually means an element is missing from the list, most often the oxygen that is worked out by difference in a combustion analysis. Add the missing element and the ratio usually snaps to cleaner whole numbers.",
      },
      {
        q: "What is the difference between an empirical and a molecular formula?",
        a: "The empirical formula is the simplest whole number ratio of atoms, so glucose, formaldehyde and acetic acid all share CH2O. The molecular formula is the actual count in one molecule, which needs the molar mass: 180.16 g/mol divided by the 30.03 g/mol of CH2O gives six, so glucose is C6H12O6.",
      },
    ],
  },
};
