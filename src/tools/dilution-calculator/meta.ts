import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "dilution-calculator",
  icon: "TestTube",
  name: "Dilution Calculator",
  description: "Solve C1V1 equals C2V2 for any missing concentration or volume.",
  category: "Chemistry",
  keywords: [
    "dilution calculator",
    "c1v1 c2v2 calculator",
    "serial dilution calculator",
    "stock solution dilution",
    "dilution factor calculator",
    "how to dilute a solution",
  ],
  searchTerms: [
    "m1v1 m2v2",
    "stock to working solution",
    "dilute acid",
    "working concentration",
    "ppm dilution",
    "percent solution dilution",
    "buffer dilution",
    "titre",
    "two fold dilution",
    "ten fold dilution",
    "plate dilution series",
    "how much stock do i need",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Mode",
      default: "solve",
      options: [
        {
          value: "solve",
          label: "Single dilution (C1V1 = C2V2)",
          synonyms: ["c1v1", "one step", "simple", "stock to working"],
        },
        {
          value: "serial",
          label: "Serial dilution series",
          synonyms: ["serial", "series", "tubes", "plate", "two fold", "ten fold"],
        },
      ],
    },
    { kind: "number", id: "decimals", label: "Decimal places", default: 4, min: 0, max: 8, step: 1 },
  ],
  examples: [
    { label: "Dilute a 2 M stock to 0.1 M", input: "C1=2 M, C2=0.1 M, V2=100 mL" },
    {
      label: "Ten fold series in 1 mL tubes",
      input: "C1=1 M, factor=1:10, steps=6, volume=1 mL",
      opts: { mode: "serial" },
    },
    { label: "Cross from molar to mg/mL", input: "C1=1 M, C2=5.844 mg/mL, V2=100 mL, molarMass=58.44" },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Solves C1V1 = C2V2 for whichever one of the four values you are missing, in molar units (M, mM, uM, nM), mass per volume units (g/L, mg/mL, ug/mL, mg/L, ppm, ppb), percent weight in volume, or the X folds of a concentrated buffer. It reports the dilution factor, how much solvent to add, and a plain sentence telling you what to measure. A second mode builds a full serial dilution table: the concentration in every tube, how much to carry forward, and how much diluent each tube starts with.",
    how: "Type the values you have as name=value pairs, for example \"C1=2 M, C2=0.1 M, V2=100 mL\", and the fourth one is filled in. Give all four and it checks them against each other instead. For a series, switch the mode and give a stock, a factor (10 or 1:10 both work), the number of steps, and the volume in each tube. Add molarMass=58.44 when one concentration is molar and the other is a mass per volume, because that conversion needs the compound's formula weight.",
    why: "Dilution pages elsewhere lock you into one unit family, silently assume percent means volume in volume, or hide the serial dilution table behind a signup. This one keeps molar, mass per volume, percent and fold units apart, refuses to cross between them without the molar mass rather than quietly guessing, and states which convention it used for percent and parts per million. It runs entirely in your browser, so your inputs never leave your device.",
    faq: [
      {
        q: "Does percent mean weight in volume or volume in volume?",
        a: "Weight in volume: 1% is 1 gram of solute made up to 100 millilitres, which is 10 g/L. The output says so whenever a percent is involved. If your stock is a volume in volume percentage, such as a 70% alcohol, the ratio math is still correct because both sides are the same kind of percentage, but the mass per volume conversion is not.",
      },
      {
        q: "Why does it refuse to convert my molar stock to mg/mL?",
        a: "Molar concentration counts particles and mass concentration weighs them, so the two only meet through the compound's molar mass. Add molarMass=58.44 (or whatever your compound weighs) and the conversion goes through. Without it, the tool would have to guess a compound, and a wrong guess is worse than a clear error.",
      },
      {
        q: "Is the solvent volume exactly the final volume minus the stock volume?",
        a: "Only when the volumes add, which is a good approximation for dilute aqueous solutions and a poor one for concentrated acids and alcohols. That is why the preparation sentence says to add solvent up to a final volume rather than to add a fixed amount of solvent: making up to the mark in a volumetric flask is right in every case.",
      },
    ],
  },
};
