import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "pcb-trace-width",
  icon: "CircuitBoard",
  name: "PCB Trace Width Calculator",
  description:
    "Calculate IPC-2221 trace width for a target current, copper weight, and temperature rise, or the max current a given width can carry.",
  category: "Electronics",
  keywords: [
    "pcb trace width calculator",
    "ipc-2221 calculator",
    "trace current capacity",
    "copper weight trace width",
    "pcb trace resistance",
    "trace voltage drop calculator",
    "pcb copper weight calculator",
  ],
  searchTerms: [
    "ipc-2152",
    "trace voltage drop",
    "internal vs external trace",
    "oz copper thickness",
    "pcb current carrying capacity",
    "copper trace resistance calculator",
    "pcb heat rise calculator",
    "trace power loss",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Calculation",
      default: "width-for-current",
      options: [
        {
          value: "width-for-current",
          label: "Width for a current",
          synonyms: ["required trace width", "size trace for amps", "what width do i need"],
        },
        {
          value: "current-for-width",
          label: "Current for a width",
          synonyms: [
            "max current for width",
            "ampacity of trace",
            "how much current can this trace carry",
          ],
        },
      ],
    },
    {
      kind: "select",
      id: "layer",
      label: "Layer",
      default: "external",
      options: [
        {
          value: "external",
          label: "External",
          synonyms: ["outer layer", "surface trace", "top or bottom copper"],
        },
        {
          value: "internal",
          label: "Internal",
          synonyms: ["inner layer", "buried trace", "internal copper"],
        },
      ],
    },
    {
      kind: "select",
      id: "copperWeight",
      label: "Copper weight",
      default: "1",
      options: [
        {
          value: "0.5",
          label: "0.5 oz",
          synonyms: ["half ounce copper", "0.5 oz copper", "thin copper"],
        },
        {
          value: "1",
          label: "1 oz",
          synonyms: ["1 oz copper", "standard copper weight", "one ounce copper"],
        },
        {
          value: "2",
          label: "2 oz",
          synonyms: ["2 oz copper", "heavy copper", "two ounce copper"],
        },
      ],
    },
  ],
  examples: [
    {
      label: "Width for 3A, 10C rise, external 1oz",
      input: "current=3",
      opts: { mode: "width-for-current", layer: "external", copperWeight: "1" },
    },
    {
      label: "Max current for a 20 mil trace",
      input: "width=20mil",
      opts: { mode: "current-for-width" },
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Calculates the minimum copper trace width an IPC-2221 PCB needs to carry a target current at a chosen temperature rise, or the maximum current a given trace width can carry. Handles internal and external layers, which dissipate heat differently, copper weights from 0.5 to 2 ounces, and an optional trace length to also estimate resistance, voltage drop, and power loss.",
    how: "Pick a mode, layer, and copper weight, then type values as key=value tokens. For width-for-current, give a current such as current=3; for current-for-width, give a trace width such as width=20mil or width=0.5mm. Add temprise=10 to set the target temperature rise in degrees C, and length=0.1m or length=4ft to also see resistance, voltage drop, and power loss over that length.",
    why: "Most online IPC-2221 calculators only run in one direction and hide the temperature rise assumption, the resistivity baseline, and how far short IPC-2221 falls of the newer IPC-2152 standard. This one computes both directions straight from the formula, includes a reference table across a current range, and your inputs never leave your device.",
    faq: [
      {
        q: "Why does an internal trace need to be wider than an external trace for the same current?",
        a: "An internal trace is buried inside the board with no direct exposure to air, so it dissipates heat far less efficiently than a trace on the outer surface. IPC-2221 models this with a much smaller constant for internal traces, k = 0.0021 versus k = 0.0647 for external, which the formula turns into a wider required trace for the same current and temperature rise target.",
      },
      {
        q: "Should I use IPC-2221 or IPC-2152 for my design?",
        a: "IPC-2221 is the classic empirical formula and works fine for early estimates and low-risk designs. IPC-2152, published in 2009, also accounts for board thickness, trace location, and nearby traces, and generally recommends wider traces for the same current, so a high-current or safety-critical design should be cross checked against IPC-2152 charts or your fabricator's own capability data.",
      },
      {
        q: "What temperature rise should I pick for my design?",
        a: "10 degrees C is the most common default and a reasonable starting point for general purpose boards. A tighter rise like 5 degrees C is more conservative for temperature sensitive designs, while a looser rise like 20 degrees C or higher lets you use a narrower trace but runs the board hotter, so check your enclosure and nearby component ratings before choosing a high value.",
      },
    ],
  },
};
