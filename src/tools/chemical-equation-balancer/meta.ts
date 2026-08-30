import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "chemical-equation-balancer",
  icon: "ArrowRightLeft",
  name: "Chemical Equation Balancer",
  description: "Balance any chemical equation automatically and show the working.",
  category: "Chemistry",
  keywords: [
    "chemical equation balancer",
    "balance chemical equations",
    "equation balancer chemistry",
    "balance redox equations",
    "reaction type identifier",
    "net ionic equation balancer",
  ],
  searchTerms: [
    "balance equations",
    "stoichiometric coefficients",
    "reaction balancer",
    "balancing equations calculator",
    "combustion equation",
    "synthesis reaction",
    "decomposition reaction",
    "single displacement",
    "double displacement",
    "metathesis",
    "half reaction",
    "ionic charge balance",
    "coefficient calculator",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "arrow",
      label: "Arrow style",
      default: "arrow",
      options: [
        { value: "arrow", label: "Plain arrow (->)", synonyms: ["ascii", "dash", "text arrow"] },
        { value: "unicode", label: "Unicode arrow", synonyms: ["rightwards arrow", "pretty"] },
        { value: "equals", label: "Equals sign", synonyms: ["=", "equality", "equation style"] },
      ],
    },
    { kind: "boolean", id: "keepStates", label: "Keep state labels", default: true },
    { kind: "boolean", id: "showMasses", label: "Show molar masses", default: false },
  ],
  examples: [
    { label: "Rusting iron", input: "Fe + O2 -> Fe2O3" },
    { label: "Permanganate redox in acid", input: "MnO4- + Fe2+ + H+ -> Mn2+ + Fe3+ + H2O" },
    { label: "Lead iodide precipitate", input: "Pb(NO3)2(aq) + KI(aq) -> PbI2(s) + KNO3(aq)" },
    { label: "Propane combustion", input: "C3H8 + O2 -> CO2 + H2O" },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Balances a chemical equation by solving the element conservation matrix exactly, so the coefficients come back as the smallest whole numbers with no rounding anywhere in the working. It reads state labels such as (s) and (aq), ionic charges written as Fe2+ or SO4^2-, hydrates joined with a dot or a middle dot, nested brackets, unicode subscripts, and the arrow written as ->, =>, =, or a unicode arrow. Alongside the balanced line you get the coefficient table, an atom by atom balance check, a net charge check for ionic equations, and a guess at the reaction family.",
    how: "Type or paste the skeleton equation, coefficients optional, and read the balanced line at the top. Any coefficients you typed are ignored and worked out from scratch, and the tool tells you when yours were already the smallest set. Switch the arrow style or turn off state labels in the options if you want to paste the result somewhere else, and turn on molar masses when the next step is a stoichiometry calculation.",
    why: "Most equation balancers online float the answer in a page of ads, refuse ionic species outright, or quietly drop the water of hydration. This one solves the system over exact rational arithmetic instead of floating point, so an equation either balances exactly or it tells you why it cannot: no whole number solution exists, or the input is really two independent reactions written as one. Everything runs in your browser, so your inputs never leave your device.",
    faq: [
      {
        q: "How does it read a charge like MnO4- or Fe2+?",
        a: "The caret form is always literal, so SO4^2- is sulfate with a charge of two. Without a caret, repeated signs carry the magnitude (Ca++ is 2+), a run of two or more digits splits so Cr2O72- is dichromate with a charge of two, and a single digit before one sign is the charge only when what is left is a lone element symbol. That is why Fe2+ is iron with a charge of two while MnO4- keeps its four oxygens.",
      },
      {
        q: "Why does it say my equation has more than one solution?",
        a: "The conservation matrix has a nullspace of dimension two or more, which means the species you wrote can react in two independent ways. Usually that is two separate reactions pasted into one line, or an extra species that is not really involved. Split them and balance each on its own.",
      },
      {
        q: "Does it balance redox half reactions?",
        a: "Yes, as long as the electrons or the charges are written out. A charge row joins the element rows whenever any species carries a charge, so MnO4- + Fe2+ + H+ balances on both mass and charge. The reaction type line also flags a likely redox when an element appears uncombined on one side and combined on the other.",
      },
    ],
  },
};
