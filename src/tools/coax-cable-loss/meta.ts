import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "coax-cable-loss",
  icon: "Cable",
  name: "Coax Cable Loss Calculator",
  description:
    "Signal loss over a coax run by cable type, length, and frequency, with power delivered and a compare-all-cables view.",
  category: "RF",
  keywords: [
    "coax cable loss calculator",
    "rg8x loss calculator",
    "lmr400 loss calculator",
    "coax attenuation calculator",
    "cable loss chart",
    "antenna feedline loss",
    "coax dB per 100 feet",
  ],
  searchTerms: [
    "rg58 loss chart",
    "lmr240 attenuation",
    "lmr600 attenuation",
    "heliax loss calculator",
    "coax cable attenuation table",
    "feedline loss calculator",
    "power loss in coax",
    "dB per 100 ft chart",
    "which coax cable to use",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "cable",
      label: "Cable type",
      default: "rg8x",
      options: [
        { value: "rg174", label: "RG-174", synonyms: ["rg-174", "rg174u", "thin patch cable"] },
        { value: "rg58", label: "RG-58", synonyms: ["rg-58", "rg58u", "rg58au"] },
        { value: "rg8x", label: "RG-8X", synonyms: ["rg-8x", "mini8", "mini-8"] },
        { value: "rg8", label: "RG-8/213", synonyms: ["rg-8", "rg213", "rg-213", "rg8u"] },
        { value: "rg6", label: "RG-6", synonyms: ["rg-6", "rg6u", "cable tv coax"] },
        { value: "rg59", label: "RG-59", synonyms: ["rg-59", "rg59u"] },
        { value: "lmr195", label: "LMR-195", synonyms: ["lmr-195"] },
        { value: "lmr240", label: "LMR-240", synonyms: ["lmr-240"] },
        { value: "lmr400", label: "LMR-400", synonyms: ["lmr-400"] },
        { value: "lmr600", label: "LMR-600", synonyms: ["lmr-600"] },
        {
          value: "heliax12",
          label: "Heliax 1/2 in (LDF4-50A)",
          synonyms: ["heliax", "ldf4-50a", "half inch heliax"],
        },
      ],
    },
    {
      kind: "boolean",
      id: "compareAll",
      label: "Compare all cable types at this length and frequency",
      default: false,
    },
  ],
  examples: [
    { label: "100 ft of LMR-400 at 446 MHz", input: "100ft 446MHz", opts: { cable: "lmr400" } },
    {
      label: "30 m of RG-8X at 915 MHz with 5W input",
      input: "30m 915MHz power=5W",
      opts: { cable: "rg8x" },
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: 'Calculates the loss over a run of coax at a given frequency and length, for eleven common cable types from thin RG-174 patch cable up to 1/2 inch Heliax hardline. Attenuation figures come from a bundled table at 30, 50, 150, 450, 900, 1500, 2400, and 5800 MHz, log-log interpolated for any frequency in between (and extrapolated outside that range). Input is plain text like "100ft 446MHz" or "length=30m freq=915MHz power=5W", and an optional compare mode ranks every cable type at once.',
    how: 'Type a length and a frequency, either as bare tokens ("100ft 446MHz") or as length= and freq= keys, and pick a cable type from the dropdown. Add power=5W or power=37dBm to also see the power delivered to the load and the percent lost in the cable. Turn on compare mode to see every bundled cable type ranked from lowest to highest loss for the same run.',
    why: "Most coax loss calculators cover two or three popular cable types and use a flat line between chart points instead of the log-log curve real attenuation actually follows. This one covers eleven cable types side by side, interpolates properly, and adds a power-delivered figure so you can see the real world impact of a lossy run, not just a dB number. Your inputs never leave your device.",
    faq: [
      {
        q: "Where do the attenuation figures come from?",
        a: "Every cable's numbers were checked directly against its manufacturer datasheet: Belden for the RG series (8259 for RG-58, 9258 for RG-8X, 8267 mil-spec RG-213 for RG-8/213, 1694A for RG-6, 9259 for RG-59, 8216 for RG-174), Times Microwave for the LMR series (LMR-195, LMR-240, LMR-400, LMR-600), and CommScope/Andrew for Heliax LDF4-50A. Where a datasheet does not publish a point above 1000 MHz, the 1500, 2400, and 5800 MHz figures are extrapolated with the same skin-effect-plus-dielectric-loss curve (attenuation = A times the square root of frequency, plus B times frequency) that Times Microwave itself publishes for the LMR line, fit to that cable's own published points; every other figure is the manufacturer's own published number or a log-log interpolation between two of them. Treat this as a close reference, not a substitute for the exact manufacturer datasheet for your specific cable batch and connectors.",
      },
      {
        q: "Sources",
        a: "RG-58: Belden 8259. RG-8X: Belden 9258. RG-8/213: Belden 8267 (RG-213, mil-spec). RG-6: Belden 1694A. RG-59: Belden 9259. RG-174: Belden 8216. All six retrieved from catalog.belden.com/techdata. LMR-195, LMR-240, LMR-400, LMR-600: Times Microwave Systems datasheets. Heliax 1/2 in: CommScope/Andrew LDF4-50A product specification. All sources retrieved 2026-08-30; see the source field on each cable in the tool's data file for the exact URL used.",
      },
      {
        q: "Does this account for connector loss or a mismatched antenna?",
        a: "No. The figures here are the cable's own matched-line attenuation only. Connectors add a small additional loss per connection (often a few tenths of a dB each), and an antenna with a poor VSWR adds further loss that grows with both the mismatch and the cable length; see the VSWR and Return Loss tool for the mismatch loss side of that.",
      },
      {
        q: "Why does a thicker cable lose less signal?",
        a: "Coax loss at RF is dominated by skin effect resistance in the center conductor and shield, which scales down as the conductor's surface area goes up. A physically larger cable like LMR-400 or Heliax has more conductor surface area than thin RG-174, so the same current produces less resistive loss per foot, at the cost of being heavier, stiffer, and more expensive.",
      },
    ],
  },
};
