import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "vswr-return-loss",
  icon: "ArrowRightLeft",
  name: "VSWR and Return Loss Converter",
  description:
    "Convert between VSWR, return loss, reflection coefficient, mismatch loss, and reflected power, with a reference table from 1.0 to 3.0 VSWR.",
  category: "RF",
  keywords: [
    "vswr calculator",
    "return loss calculator",
    "vswr to return loss",
    "reflection coefficient calculator",
    "mismatch loss calculator",
    "swr calculator",
    "antenna vswr chart",
  ],
  searchTerms: [
    "standing wave ratio calculator",
    "swr to db",
    "reflected power calculator",
    "gamma reflection coefficient",
    "vswr chart",
    "antenna matching loss",
    "vswr table",
    "reflected power percent",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "quantity",
      label: "Value you are entering",
      default: "vswr",
      options: [
        { value: "vswr", label: "VSWR", synonyms: ["standing wave ratio", "swr", "1.5:1"] },
        {
          value: "return-loss",
          label: "Return loss (dB)",
          synonyms: ["rl", "reflection loss", "db"],
        },
        {
          value: "reflection-coefficient",
          label: "Reflection coefficient (gamma)",
          synonyms: ["gamma", "rho", "voltage reflection coefficient"],
        },
        {
          value: "mismatch-loss",
          label: "Mismatch loss (dB)",
          synonyms: ["insertion loss due to mismatch", "transmission loss"],
        },
        {
          value: "power-ratio",
          label: "Reflected power (%)",
          synonyms: ["reflected power percent", "forward reflected power", "power reflected"],
        },
      ],
    },
  ],
  examples: [
    { label: "VSWR 1.5:1", input: "1.5", opts: { quantity: "vswr" } },
    { label: "Return loss 20 dB", input: "20", opts: { quantity: "return-loss" } },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Converts any one of VSWR, return loss in dB, reflection coefficient magnitude, mismatch loss in dB, or reflected power percent into every other quantity, plus the power delivered to the load. A reference table from 1.0 to 3.0 VSWR is always included for a quick sanity check.",
    how: 'Pick which quantity you are entering, then type a plain number, such as "1.5" for VSWR 1.5:1 or "20" for a 20 dB return loss. Trailing suffixes like ":1" or "dB" are accepted and ignored. Every derived quantity, the reflection coefficient, mismatch loss, and reflected power fraction, appears in the result.',
    why: "Most VSWR calculators convert only VSWR to return loss and stop there. This one covers all five common ways antenna and cable mismatch is quoted, converts between any of them, and shows the full reference table alongside so you do not need a second lookup chart. Your inputs never leave your device.",
    faq: [
      {
        q: "What is a good VSWR for an antenna?",
        a: "A VSWR of 2.0:1 or better (return loss of about 9.5 dB or better) is generally considered acceptable for amateur and commercial use, since it means over 88% of forward power reaches the antenna. Many transceivers reduce power or shut down above 3.0:1 to protect the final amplifier. A VSWR under 1.5:1 is a common target for a well matched system.",
      },
      {
        q: "What is the difference between return loss and mismatch loss?",
        a: "Return loss measures how much power is reflected back toward the source, expressed as a positive dB number where higher means less reflection. Mismatch loss measures how much less power reaches the load compared to a perfectly matched line, and is almost always a small fraction of a dB even at a fairly high VSWR, because most of the reflected power at any tolerable mismatch is quite small.",
      },
      {
        q: "Does VSWR alone tell you if a cable or connector is damaged?",
        a: "No. VSWR only measures the ratio of forward to reflected voltage at the point it is measured, so a good VSWR reading at the transmitter end does not rule out a lossy cable, since cable loss between the measurement point and the antenna hides reflections at the far end. For expected loss over a specific cable run at a given frequency, see the Coax Cable Loss tool.",
      },
    ],
  },
};
