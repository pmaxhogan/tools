import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "stoichiometry-calculator",
  icon: "Sigma",
  name: "Stoichiometry Calculator",
  description:
    "Mole ratios, limiting reactant and theoretical yield from a balanced equation.",
  category: "Chemistry",
  keywords: [
    "stoichiometry calculator",
    "limiting reactant calculator",
    "theoretical yield calculator",
    "percent yield calculator",
    "mole ratio calculator",
    "excess reagent calculator",
  ],
  searchTerms: [
    "limiting reagent",
    "excess reactant",
    "actual yield",
    "grams to moles reaction",
    "mole to mole conversion",
    "reaction yield",
    "mass to mass stoichiometry",
    "how much product",
    "leftover reactant",
    "extent of reaction",
    "gram formula stoichiometry",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    { kind: "boolean", id: "autoBalance", label: "Balance the equation first", default: true },
    { kind: "number", id: "decimals", label: "Decimal places", default: 4, min: 0, max: 8, step: 1 },
  ],
  examples: [
    {
      label: "Rusting iron with a measured yield",
      input: "Fe + O2 -> Fe2O3\nFe: 10 g\nO2: 5 g\nactual Fe2O3: 12 g",
    },
    {
      label: "Ammonia synthesis in moles",
      input: "N2 + H2 -> NH3\nN2: 1 mol\nH2: 2.5 mol",
    },
    {
      label: "Neutralizing hydrochloric acid",
      input: "HCl + NaOH -> NaCl + H2O\nHCl: 3.65 g\nNaOH: 5 g",
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Takes a reaction and the amounts you actually have, then works out the limiting reagent, how much of every product you can theoretically make in both moles and grams, how much of each excess reactant is left over, and the percent yield when you also give a measured amount. The equation is balanced for you first, using exact rational arithmetic, so a skeleton equation is enough. Molar masses come from the standard atomic weights, so grams and moles are interchangeable in the input.",
    how: "Put the equation on the first line, then one amount per line underneath as \"species: number unit\", for example \"Fe: 10 g\" or \"O2 = 0.25 mol\". Units can be g, kg, mg, ug, mol, mmol or umol, and leaving the unit off means grams. Prefix a product line with the word actual to record a measured yield and get the percent yield alongside it. Turn off Balance the equation first if you want the coefficients you typed to be used as they are.",
    why: "Most stoichiometry sites make you fill in a wizard one box at a time, handle exactly one reactant, and then hide the limiting reagent working behind an upsell. This one takes the whole problem as a few lines of text, balances the equation itself, reports every product and every leftover rather than the single number you asked for, and shows the mole conversions it used. It runs entirely in your browser, so your inputs never leave your device.",
    faq: [
      {
        q: "What happens if I only give one reactant amount?",
        a: "That reactant becomes the limiting one and everything else is reported as assumed in excess. The results line says so explicitly, because a theoretical yield computed that way is only right if the other reactants really are in excess.",
      },
      {
        q: "How is percent yield calculated?",
        a: "Measured moles divided by theoretical moles, times one hundred. Write the measured amount on its own line with the word actual in front, as in \"actual Fe2O3: 12 g\", and the mass is converted to moles with the same molar mass used everywhere else. A percent yield above one hundred usually means the product was not dry.",
      },
      {
        q: "Why is my answer slightly different from my textbook?",
        a: "The atomic weights here come from the PubChem periodic table and are rounded to the precision it publishes, such as 55.84 for iron and 63.55 for copper. A textbook that carries more digits can land a few thousandths of a gram per mole away, which shows up in the fourth or fifth significant figure of a yield.",
      },
    ],
  },
};
