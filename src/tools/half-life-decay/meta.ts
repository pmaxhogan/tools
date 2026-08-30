import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "half-life-decay",
  icon: "Hourglass",
  name: "Half-Life and Decay Calculator",
  description: "Remaining quantity over time for any half-life, with a decay curve.",
  category: "Chemistry",
  keywords: [
    "half life calculator",
    "radioactive decay calculator",
    "decay constant calculator",
    "carbon 14 dating calculator",
    "remaining activity calculator",
    "mean lifetime calculator",
  ],
  searchTerms: [
    "exponential decay",
    "radiocarbon dating",
    "isotope decay",
    "becquerel",
    "curie activity",
    "how much is left",
    "time to decay",
    "nuclear decay",
    "lambda decay constant",
    "tau mean life",
    "radiopharmaceutical decay",
    "technetium generator",
    "fluorine 18 pet",
    "drug half life",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Solve for",
      default: "remaining",
      options: [
        {
          value: "remaining",
          label: "What is left after a time",
          synonyms: ["remaining", "amount left", "forward", "decay to"],
        },
        {
          value: "time",
          label: "How long to reach a level",
          synonyms: ["time", "age", "how long", "date", "backwards"],
        },
      ],
    },
    {
      kind: "select",
      id: "isotope",
      label: "Isotope preset",
      default: "none",
      ui: "select",
      options: [
        {
          value: "none",
          label: "No preset (type your own half-life)",
          synonyms: ["custom", "manual", "own value", "generic"],
        },
      ],
      groups: [
        {
          label: "Dating and geology",
          synonyms: ["dating", "geology", "archaeology", "rocks", "age of the earth"],
          options: [
            {
              value: "c-14",
              label: "Carbon 14 (5700 y)",
              synonyms: ["radiocarbon", "c14", "carbon dating", "archaeology"],
            },
            {
              value: "k-40",
              label: "Potassium 40 (1.248e9 y)",
              synonyms: ["k40", "potassium argon", "bananas", "geochronology"],
            },
            {
              value: "u-235",
              label: "Uranium 235 (7.04e8 y)",
              synonyms: ["u235", "enriched uranium", "fissile"],
            },
            {
              value: "u-238",
              label: "Uranium 238 (4.468e9 y)",
              synonyms: ["u238", "depleted uranium", "lead dating"],
            },
            {
              value: "th-232",
              label: "Thorium 232 (1.405e10 y)",
              synonyms: ["th232", "thorium series", "monazite"],
            },
            {
              value: "ra-226",
              label: "Radium 226 (1600 y)",
              synonyms: ["ra226", "radium", "curie", "radon parent"],
            },
          ],
        },
        {
          label: "Medical isotopes",
          synonyms: ["medicine", "nuclear medicine", "imaging", "therapy", "hospital"],
          options: [
            {
              value: "tc-99m",
              label: "Technetium 99m (6.0067 h)",
              synonyms: ["tc99m", "technetium", "spect", "generator", "moly cow"],
            },
            {
              value: "i-131",
              label: "Iodine 131 (8.0252 d)",
              synonyms: ["i131", "thyroid", "radioiodine", "ablation"],
            },
            {
              value: "i-125",
              label: "Iodine 125 (59.4 d)",
              synonyms: ["i125", "brachytherapy", "seed implant"],
            },
            {
              value: "f-18",
              label: "Fluorine 18 (109.77 min)",
              synonyms: ["f18", "fdg", "pet scan", "positron"],
            },
            {
              value: "p-32",
              label: "Phosphorus 32 (14.268 d)",
              synonyms: ["p32", "beta emitter", "dna labeling"],
            },
            {
              value: "co-60",
              label: "Cobalt 60 (5.2711 y)",
              synonyms: ["co60", "gamma knife", "sterilization", "teletherapy"],
            },
          ],
        },
        {
          label: "Reactor products and sources",
          synonyms: ["fallout", "reactor", "fission products", "waste", "sources"],
          options: [
            {
              value: "cs-137",
              label: "Cesium 137 (30.08 y)",
              synonyms: ["cs137", "caesium", "fallout", "chernobyl", "fukushima"],
            },
            {
              value: "sr-90",
              label: "Strontium 90 (28.79 y)",
              synonyms: ["sr90", "bone seeker", "fission product"],
            },
            {
              value: "pu-239",
              label: "Plutonium 239 (24110 y)",
              synonyms: ["pu239", "plutonium", "weapons grade"],
            },
            {
              value: "am-241",
              label: "Americium 241 (432.6 y)",
              synonyms: ["am241", "smoke detector", "alpha source"],
            },
            {
              value: "h-3",
              label: "Tritium (12.32 y)",
              synonyms: ["h3", "tritium", "exit sign", "glow vial", "fusion fuel"],
            },
            {
              value: "po-210",
              label: "Polonium 210 (138.376 d)",
              synonyms: ["po210", "polonium", "alpha emitter"],
            },
          ],
        },
      ],
    },
    {
      kind: "select",
      id: "timeUnit",
      label: "Time unit",
      default: "auto",
      options: [
        { value: "auto", label: "Pick automatically", synonyms: ["auto", "best fit", "default"] },
        { value: "s", label: "Seconds", synonyms: ["s", "sec", "seconds"] },
        { value: "min", label: "Minutes", synonyms: ["min", "minutes"] },
        { value: "h", label: "Hours", synonyms: ["h", "hr", "hours"] },
        { value: "d", label: "Days", synonyms: ["d", "days"] },
        { value: "y", label: "Years", synonyms: ["y", "yr", "years", "annum"] },
      ],
    },
    { kind: "boolean", id: "showTable", label: "Show the half-life table", default: true },
    { kind: "number", id: "decimals", label: "Decimal places", default: 4, min: 0, max: 8, step: 1 },
  ],
  examples: [
    {
      label: "Radiocarbon age of a sample",
      input: "remaining=25%",
      opts: { isotope: "c-14", mode: "time", timeUnit: "y" },
    },
    {
      label: "Iodine 131 dose after a week",
      input: "t=7 d, N0=200 MBq",
      opts: { isotope: "i-131", mode: "remaining", timeUnit: "d" },
    },
    {
      label: "Custom half-life",
      input: "halfLife=10 s, t=35 s, N0=100 g",
      opts: { isotope: "none", timeUnit: "s" },
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Works out how much of a radioactive sample is left after a given time, or how long it takes to fall to a given level. Give a half-life, a decay constant or a mean lifetime and it prints all three, plus the number of half-lives elapsed, the remaining and decayed fractions, and the remaining amount in whatever unit you started with. Starting amounts in grams, moles, nuclei, becquerels or curies also give a nuclei count and an activity, and there is a table of what is left after one through ten half-lives.",
    how: "Type the values you have as name=value pairs, for example \"halfLife=5700 y, t=11400 y, N0=100 g\". A colon works in place of the equals sign, and pairs can be separated by spaces, commas or new lines. Pick an isotope preset if you would rather not look the half-life up, and switch Solve for to the second mode to find the elapsed time from a remaining percentage instead. Times accept s, min, h, d, wk, y, ky, My and Gy.",
    why: "Half-life pages online usually solve exactly one of the four cases, hide the decay constant, and cannot take a mass or an activity as the starting amount. This one accepts any of the three time constants, converts between mass, moles, nuclei and activity, solves in either direction, and prints the whole half-life table alongside the answer. It runs entirely in your browser, so your inputs never leave your device.",
    faq: [
      {
        q: "Where do the preset half-lives come from?",
        a: "They are the recommended values from the NUBASE and ENSDF evaluations, as published in the Nuclear Wallet Cards and the IAEA Live Chart of Nuclides, quoted to the precision given there. Carbon 14 uses the Cambridge half-life of 5700 years rather than the older Libby value of 5568 years, which is why a radiocarbon age here can differ slightly from an uncalibrated one.",
      },
      {
        q: "Why is there no activity in my results?",
        a: "Activity is the decay constant times the number of nuclei, so it needs a nuclei count. A mass alone is not enough without a molar mass, so either pick an isotope preset, which supplies its mass number, or add molarMass=137 yourself. A starting amount given as a percentage or a bare number is relative, so no activity is reported for it at all.",
      },
      {
        q: "Is a year 365 or 365.25 days here?",
        a: "A year is the Julian year of 365.25 days, which is 31,557,600 seconds, the convention used in nuclear data tables. Over a handful of half-lives the difference from a 365 day year is far smaller than the uncertainty in a published half-life, but it matters when you compare a geological age against another calculator.",
      },
    ],
  },
};
