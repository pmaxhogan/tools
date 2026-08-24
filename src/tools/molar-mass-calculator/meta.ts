import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "molar-mass-calculator",
  icon: "FlaskConical",
  name: "Molar Mass Calculator",
  description:
    "Work out the molar mass, percent composition, and atom counts of any chemical formula.",
  category: "Chemistry",
  keywords: [
    "molar mass calculator",
    "molecular weight calculator",
    "formula weight",
    "percent composition",
    "gram formula mass",
    "molar mass of a compound",
  ],
  searchTerms: [
    "molecular weight",
    "formula mass",
    "molar mass",
    "relative molecular mass",
    "gram molecular weight",
    "percentage composition",
    "mass percent",
    "atomic weight sum",
    "hydrate molar mass",
    "sulphate",
    "sulphuric acid",
    "aluminium",
    "caesium",
    "stoichiometry helper",
    "g/mol",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "number",
      id: "decimals",
      label: "Decimal places",
      default: 3,
      min: 0,
      max: 6,
      step: 1,
    },
  ],
  examples: [
    { label: "Copper sulfate pentahydrate", input: "CuSO4.5H2O" },
    { label: "Calcium hydroxide", input: "Ca(OH)2" },
    { label: "Glucose", input: "C6H12O6" },
    { label: "Sulfate ion", input: "SO4^2-" },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Parses a chemical formula and reports its molar mass in grams per mole, the percent composition of every element, and the atom counts. The parser handles nested parentheses and brackets, hydrates written with a dot or a middle dot, leading coefficients like the 5 in CuSO4.5H2O, unicode subscripts, state labels such as (aq), and ionic charges. It also prints the same compound in Hill notation, which is the ordering used by chemical indexes and most databases.",
    how: "Type or paste a formula such as Ca(OH)2, CuSO4.5H2O, or [Cu(NH3)4]SO4 and read the result. Raise or lower the decimal places if you need more or fewer significant figures than the default three. Every row has its own copy button, and the formula travels in the URL so you can share the exact calculation.",
    why: "The usual molar mass sites wrap the answer in ads, ask you to sign in for the percent composition, or silently drop the water of hydration. This one parses the whole formula, tells you exactly which element symbol it could not read when something is wrong, and runs entirely in your browser, so your inputs never leave your device.",
    faq: [
      {
        q: "Which atomic weights does it use?",
        a: "The standard atomic weights published in the PubChem periodic table, such as 1.008 for hydrogen and 63.55 for copper. They are rounded to the precision PubChem publishes, so a result can differ from a full precision IUPAC calculation by a few thousandths of a gram per mole.",
      },
      {
        q: "Does it handle hydrates and charges?",
        a: "Yes. Write a hydrate with a period or a middle dot, as in CuSO4.5H2O or CuSO4 5H2O, and both parts are counted. A charge such as SO4^2- is reported separately and then ignored, because the mass of the missing or extra electrons is far below the precision of the atomic weights.",
      },
      {
        q: "Why does D2O fail?",
        a: "Isotope shorthand is not supported. D and T are not element symbols in the periodic table this tool reads, so every mass here is a standard atomic weight. Write heavy water as H2O if you want the ordinary molar mass.",
      },
    ],
  },
};
