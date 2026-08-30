import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "lc-resonance",
  icon: "CircuitBoard",
  name: "LC Resonance Calculator",
  description:
    "Resonant frequency of an LC circuit from any two of inductance, capacitance, and frequency, plus reactance, Q factor, and bandwidth.",
  category: "RF",
  keywords: [
    "lc resonance calculator",
    "resonant frequency calculator",
    "lc circuit calculator",
    "inductor capacitor resonance",
    "tank circuit calculator",
    "q factor calculator",
    "bandwidth calculator lc",
  ],
  searchTerms: [
    "1/(2 pi sqrt(lc)) calculator",
    "resonance frequency formula",
    "series rlc bandwidth",
    "reactance calculator",
    "xl xc calculator",
    "tuned circuit calculator",
    "crystal filter bandwidth",
    "coil capacitor resonance",
  ],
  input: "text/plain",
  output: "application/json",
  examples: [
    { label: "Frequency from L and C", input: "L=10uH C=100pF" },
    { label: "Capacitance from L and f", input: "L=10uH f=7.1MHz R=5" },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: 'Solves the resonant frequency of an LC circuit from any two of inductance, capacitance, and frequency, and reports the third. Also shows the reactance at resonance (XL equals XC there), and, when a series resistance is given, the Q factor and the -3dB bandwidth of the resonance. Input is key=value pairs like "L=10uH C=100pF" or "L=10uH f=7.1MHz R=5".',
    how: "Type two of L (inductance, with nH, uH, mH, or H), C (capacitance, with pF, nF, uF, or F), and f (frequency, with Hz, kHz, MHz, or GHz) as key=value pairs separated by spaces. Add R (series resistance in ohms, or a k suffix for kilo-ohms) to also get the Q factor and bandwidth. Giving all three checks that they agree within 1% instead of silently ignoring one.",
    why: "Most LC resonance calculators only solve for frequency and stop there, leaving Q and bandwidth to a separate tool. This one solves in any direction (frequency, capacitance, or inductance, whichever you are missing), shows the reactance at resonance, and adds the Q factor and bandwidth in the same pass when you give a series resistance. Your inputs never leave your device.",
    faq: [
      {
        q: "Why does the calculator sometimes reject three given values?",
        a: "Only two of L, C, and f are independent since the third is fixed by the resonance formula f = 1 / (2 pi sqrt(L x C)). If you supply all three and they do not agree within 1%, one of them is wrong, so the tool flags the mismatch instead of silently picking two and ignoring the third.",
      },
      {
        q: "What does the Q factor tell you about a resonant circuit?",
        a: "Q factor measures how sharply tuned a resonance is: a higher Q means a narrower bandwidth and lower loss, at the cost of the circuit being more sensitive to small component drift. Q depends heavily on the resistive losses in the inductor (usually the dominant loss in a real LC tank), which is why this tool asks for a series resistance to compute it rather than assuming an ideal lossless circuit.",
      },
      {
        q: "Is this the same resonance used to size an antenna?",
        a: "No. This is electrical resonance in a lumped LC circuit, used for filters, tuned amplifiers, and matching networks. Antenna resonance is a different phenomenon involving the physical length of a conductor relative to the wavelength; for that, see the Antenna Length Calculator.",
      },
    ],
  },
};
