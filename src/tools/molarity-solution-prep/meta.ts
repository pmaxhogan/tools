import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "molarity-solution-prep",
  icon: "FlaskConical",
  name: "Molarity and Solution Prep",
  description: "Work out moles, volume or concentration, with a step-by-step prep recipe.",
  category: "Chemistry",
  keywords: [
    "molarity calculator",
    "solution preparation calculator",
    "grams to molarity calculator",
    "how many grams to make a solution",
    "molality calculator",
    "normality calculator",
  ],
  searchTerms: [
    "moles per liter",
    "make up a solution",
    "weigh out",
    "stock solution recipe",
    "percent w/v",
    "mass concentration",
    "mole fraction",
    "equivalents normality",
    "formula weight solution",
    "assay purity correction",
    "ppm solution",
    "molar solution",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "number",
      id: "equivalents",
      label: "Equivalents per mole (for normality)",
      default: 1,
      min: 1,
      max: 12,
      step: 1,
    },
    { kind: "number", id: "decimals", label: "Decimal places", default: 4, min: 0, max: 8, step: 1 },
  ],
  examples: [
    { label: "Weigh out a 0.5 M salt solution", input: "NaCl, C=0.5 M, V=250 mL" },
    { label: "Concentration from a weighed mass", input: "C6H12O6, mass=18 g, V=100 mL" },
    {
      label: "With density and assay purity",
      input: "NaOH, C=1 M, V=500 mL, density=1.04 g/mL, purity=97%",
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Turns a compound, a target concentration and a volume into the number of grams to weigh, or runs the same relationship backwards to give the concentration from a mass or the volume from a target. The molar mass comes from the formula you type, hydrates and nested brackets included, or from a molarMass override for anything the parser cannot read. Alongside the answer it prints the moles, the mass concentration, percent weight in volume, parts per million, normality at the equivalents you choose, and, once you give a density, the molality, percent weight in weight and mole fraction.",
    how: "Type the compound then the values you have, for example \"NaCl, C=0.5 M, V=250 mL\". Any two of concentration, volume and mass are enough and the third is worked out. Add purity=97% when your reagent is not pure and the weighing step is scaled up for you, and add density=1.04 g/mL when you want molality, which counts kilograms of solvent rather than liters of solution. The result ends with a three step recipe you can follow at the bench.",
    why: "Molarity pages elsewhere ask you to pick a compound from a short list, cannot read a hydrate, and quietly assume a density of exactly one when they show molality. This one parses the formula you actually have, states where the molar mass came from, corrects for assay purity, and leaves molality out with an explanation rather than approximating it. It runs entirely in your browser, so your inputs never leave your device.",
    faq: [
      {
        q: "Why does it dissolve in 60% of the final volume first?",
        a: "Because dissolving a solid changes the volume of the liquid. Adding the solute to a partly filled flask and only then making up to the mark gives the concentration you asked for, while dissolving into a full measure of solvent gives a solution that is slightly too dilute. It also gives the solid room to dissolve before the flask is full.",
      },
      {
        q: "What is the difference between molarity, molality and normality here?",
        a: "Molarity is moles of solute per liter of finished solution, molality is moles per kilogram of solvent, and normality is molarity times the number of equivalents a mole of the compound provides. Molality needs a density because it counts the solvent, not the solution, so that row only appears once you give one. Set the equivalents option to 2 for sulfuric acid or calcium hydroxide.",
      },
      {
        q: "Can it handle hydrates like copper sulfate pentahydrate?",
        a: "Yes. Write it as CuSO4.5H2O, with a period or a middle dot, and the waters are counted in the molar mass, which is what you want because the crystals you weigh carry that water. If you weigh the anhydrous salt instead, type CuSO4 and the mass drops accordingly.",
      },
    ],
  },
};
