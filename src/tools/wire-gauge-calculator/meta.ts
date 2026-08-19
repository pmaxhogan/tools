import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "wire-gauge-calculator",
  matrixSlug: "wire-gauge",
  icon: "Zap",
  name: "Wire Gauge Calculator",
  description: "AWG sizing, ampacity, and voltage drop over distance.",
  category: "Hardware",
  keywords: [
    "wire gauge calculator",
    "awg chart",
    "voltage drop calculator",
    "wire size for amps",
    "awg to mm2",
    "ampacity chart",
    "what gauge wire do i need",
  ],
  searchTerms: [
    "awg table",
    "wire resistance calculator",
    "electrical wire sizing",
    "nec 310.16 ampacity",
    "circular mils calculator",
    "wire diameter chart",
    "voltage drop over distance",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Calculation",
      default: "lookup",
      options: [
        {
          value: "lookup",
          label: "Wire size lookup",
          synonyms: ["awg chart", "wire size chart", "gauge lookup", "mm2 lookup", "wire properties"],
        },
        {
          value: "voltage-drop",
          label: "Voltage drop",
          synonyms: ["volt drop", "line loss", "drop over distance", "long wire run"],
        },
        {
          value: "size-for",
          label: "Size wire for a run",
          synonyms: ["what gauge do i need", "wire sizing", "pick a gauge", "size for amps"],
        },
      ],
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Looks up AWG and metric wire sizes (diameter, area, resistance, and NEC 310.16-style ampacity), calculates voltage drop over a run for DC, single-phase, or three-phase circuits, and finds the smallest gauge that satisfies both ampacity and a voltage drop target. Input is plain text like \"12 awg\", \"20A 30m 12awg 120V\", or \"20A 30m 120V\", not a form.",
    how: "Pick a mode, then type the wire size or circuit values as space or comma separated tokens, either bare with units (\"20A 30m 12awg 120V copper dc\") or as key=value pairs (\"current=20 length=30m gauge=12awg voltage=120\"). Lookup mode accepts an AWG gauge (\"12 awg\", \"4/0\", \"0000\") or a metric size (\"2.5 mm2\"); voltage-drop and size-for accept current, one-way length in meters or feet, voltage, and optional material and phase.",
    why: "Most wire gauge calculators online cover either the AWG chart or voltage drop, not both, and rarely show the NEC ampacity columns and hobbyist chassis-wiring figures side by side with an honest source note. This one covers lookup, voltage drop, and reverse sizing in one place, computed directly from the AWG formula rather than a static rounded table, and your inputs never leave your device.",
    faq: [
      {
        q: "Is the ampacity table here code-compliant for my installation?",
        a: "No. The NEC 310.16-style figures are a common reference for THHN/THWN-2 conductors under typical conditions, not a substitute for the full code tables, temperature and bundling adjustments, or a licensed electrician. Always follow your local electrical code for real installations.",
      },
      {
        q: "Why does the size-for mode target a 3 percent voltage drop?",
        a: "3 percent is the widely used rule of thumb for a single branch circuit, with 5 percent as the combined limit for a feeder plus branch circuit together. Neither is a hard NEC rule, but staying under them keeps voltage sag, dim lighting, and motor heating in check on a long run.",
      },
      {
        q: "How do AWG and mm2 wire sizes relate to each other?",
        a: "AWG numbers get smaller as the wire gets thicker, while mm2 is a direct cross-sectional area, so bigger means thicker. There is no exact match between the two systems since AWG steps are fixed ratios and metric sizes are round numbers, so lookups here compute the nearest equivalent by cross-sectional area rather than a rounded conversion.",
      },
    ],
  },
};
