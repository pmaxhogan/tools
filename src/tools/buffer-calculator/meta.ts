import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "buffer-calculator",
  icon: "Layers",
  name: "Buffer Calculator",
  description: "Henderson-Hasselbalch buffer pH and capacity from acid and conjugate base.",
  category: "Chemistry",
  keywords: [
    "buffer calculator",
    "henderson hasselbalch calculator",
    "buffer ph calculator",
    "buffer capacity calculator",
    "tris buffer calculator",
    "phosphate buffer calculator",
  ],
  searchTerms: [
    "acid to base ratio",
    "conjugate base",
    "buffer recipe",
    "buffering range",
    "pka buffer",
    "acetate buffer",
    "hepes buffer",
    "citrate buffer",
    "mops buffer",
    "buffer strength",
    "beta buffer capacity",
    "how much naoh before ph shifts",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Calculation",
      default: "ph",
      options: [
        {
          value: "ph",
          label: "pH from the amounts",
          synonyms: ["forward", "ph", "what ph", "from amounts"],
        },
        {
          value: "ratio",
          label: "Amounts from a target pH",
          synonyms: ["ratio", "recipe", "how much", "reverse", "target"],
        },
      ],
    },
    {
      kind: "select",
      id: "buffer",
      label: "Buffer preset",
      default: "none",
      ui: "select",
      options: [
        {
          value: "none",
          label: "No preset (type your own pKa)",
          synonyms: ["custom", "manual", "own value", "generic"],
        },
      ],
      groups: [
        {
          label: "Classic weak acid buffers",
          synonyms: ["classic", "traditional", "inorganic", "carboxylic"],
          options: [
            {
              value: "acetate",
              label: "Acetate, pKa 4.76",
              synonyms: ["acetic acid", "vinegar", "sodium acetate"],
            },
            {
              value: "formate",
              label: "Formate, pKa 3.75",
              synonyms: ["formic acid", "sodium formate", "mass spec buffer"],
            },
            {
              value: "citrate",
              label: "Citrate, pKa 3.13 / 4.76 / 6.40",
              synonyms: ["citric acid", "triprotic", "food buffer"],
            },
            {
              value: "phosphate",
              label: "Phosphate, pKa 2.15 / 7.20 / 12.35",
              synonyms: ["pbs", "sodium phosphate", "physiological", "triprotic"],
            },
            {
              value: "carbonate",
              label: "Carbonate, pKa 6.35 / 10.33",
              synonyms: ["bicarbonate", "carbonic acid", "blood buffer", "soda"],
            },
            {
              value: "borate",
              label: "Borate, pKa 9.24",
              synonyms: ["boric acid", "tbe", "gel buffer"],
            },
            {
              value: "ammonium",
              label: "Ammonium, pKa 9.25",
              synonyms: ["ammonia", "ammonium chloride", "volatile buffer"],
            },
            {
              value: "glycine",
              label: "Glycine, pKa 2.35 / 9.78",
              synonyms: ["amino acid", "running buffer", "zwitterion"],
            },
          ],
        },
        {
          label: "Good buffers (biological)",
          synonyms: ["good buffers", "zwitterionic", "biology", "cell culture", "biochemistry"],
          options: [
            {
              value: "tris",
              label: "Tris, pKa 8.06",
              synonyms: ["tris base", "trizma", "tae", "tbe", "temperature sensitive"],
            },
            { value: "hepes", label: "HEPES, pKa 7.48", synonyms: ["cell culture", "media"] },
            { value: "mes", label: "MES, pKa 6.15", synonyms: ["acidic good buffer"] },
            { value: "mops", label: "MOPS, pKa 7.20", synonyms: ["rna gel", "running buffer"] },
            { value: "pipes", label: "PIPES, pKa 6.76", synonyms: ["fixation", "cytoskeleton"] },
            { value: "bis-tris", label: "Bis-Tris, pKa 6.46", synonyms: ["gel buffer", "bis tris"] },
            { value: "tricine", label: "Tricine, pKa 8.15", synonyms: ["sds page", "peptide gel"] },
            { value: "bicine", label: "Bicine, pKa 8.35", synonyms: ["alkaline good buffer"] },
            { value: "taps", label: "TAPS, pKa 8.40", synonyms: ["alkaline good buffer"] },
            { value: "ches", label: "CHES, pKa 9.30", synonyms: ["alkaline good buffer"] },
            { value: "caps", label: "CAPS, pKa 10.40", synonyms: ["transfer buffer", "alkaline"] },
            { value: "imidazole", label: "Imidazole, pKa 6.95", synonyms: ["his tag", "elution"] },
          ],
        },
      ],
    },
    {
      kind: "number",
      id: "step",
      label: "Ionization step of a polyprotic preset",
      default: 1,
      min: 1,
      max: 3,
      step: 1,
    },
    {
      kind: "number",
      id: "temperature",
      label: "Temperature in degrees Celsius",
      default: 25,
      min: 0,
      max: 100,
      step: 1,
    },
    { kind: "number", id: "decimals", label: "Decimal places", default: 4, min: 0, max: 8, step: 1 },
  ],
  examples: [
    { label: "Acetate buffer pH from the amounts", input: "pKa=4.76, HA=0.1, A=0.15" },
    {
      label: "Recipe for a phosphate buffer at pH 7.4",
      input: "pH=7.4, total=0.1, V=1",
      opts: { mode: "ratio", buffer: "phosphate", step: "2" },
    },
    {
      label: "Tris in the cold room",
      input: "HA=0.05, A=0.05",
      opts: { buffer: "tris", temperature: "4" },
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Works a buffer in both directions. Give the weak acid and its conjugate base and it returns the pH from Henderson-Hasselbalch; give a target pH and a total concentration and it returns the two amounts to mix. Either way it also reports the differential buffer capacity, the useful pKa plus or minus one window, and how much strong acid or strong base the buffer absorbs before the pH shifts a full unit in each direction. Twenty common buffers are built in with their pKa values, including the temperature correction for Tris and the other Good buffers.",
    how: "Type the values you have as name=value pairs, for example \"pKa=4.76, HA=0.1, A=0.15\". Amounts can be concentrations or moles, because only their ratio sets the pH; add V=1 to get the moles for a given volume. Pick a preset instead of typing a pKa, use the ionization step option to choose which pKa of a polyprotic buffer applies, and set the temperature to see how a Tris or HEPES buffer moves in the cold room. Switch the mode to work the amounts out from a target pH.",
    why: "Buffer calculators elsewhere carry a short preset list, quote a single pKa for triprotic buffers, and ignore the temperature shift that makes Tris a different buffer at 4 C than at 25 C. This one carries the whole ionization series for each polyprotic buffer, corrects the temperature sensitive pKa values, and reports buffer capacity and the tolerance to added strong acid or base rather than only the pH. It runs entirely in your browser, so your inputs never leave your device.",
    faq: [
      {
        q: "How far can a buffer be pushed before it stops working?",
        a: "The rule of thumb is one pH unit either side of the pKa, which is where one component sits between ten times and one tenth of the other. Beyond that the minority component runs out quickly. The result flags whether your mixture is inside that window and prints exactly how much strong acid or strong base it absorbs before the pH moves a full unit.",
      },
      {
        q: "Why does Tris behave differently in the cold room?",
        a: "Its pKa falls about 0.028 units per degree Celsius, so a Tris buffer titrated to pH 8.0 on the bench at 25 C sits near pH 8.6 at 4 C. Set the temperature option and the preset pKa is corrected for you. HEPES, MOPS and the other Good buffers shift too, but less steeply, and the phosphate and acetate buffers barely move at all.",
      },
      {
        q: "What exactly is buffer capacity?",
        a: "The moles of strong base per liter needed to raise the pH by one unit at the current point, written beta = 2.303 times the total buffer concentration times Ka times [H+] divided by (Ka + [H+]) squared. It peaks when the pH equals the pKa, where it works out at 0.576 times the total concentration, and falls away on either side. Doubling the total concentration doubles the capacity without moving the pH.",
      },
    ],
  },
};
