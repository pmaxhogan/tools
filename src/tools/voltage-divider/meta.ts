import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "voltage-divider",
  icon: "Route",
  name: "Voltage Divider Calculator",
  description:
    "Work out output voltage, resistor values, loaded-divider sag, and common-supply ratio tables for a two-resistor divider.",
  category: "Electronics",
  keywords: [
    "voltage divider calculator",
    "resistor divider",
    "r1 r2 calculator",
    "potential divider",
    "voltage divider formula",
    "divider sag calculator",
  ],
  searchTerms: [
    "loaded voltage divider",
    "divider sag",
    "output voltage from resistors",
    "resistor ratio calculator",
    "voltage divider with load resistance",
    "vout calculator",
    "e24 voltage divider",
    "total resistance budget divider",
    "voltage divider ratio table",
  ],
  input: "text/plain",
  output: "application/json",
  examples: [
    { label: "Forward compute", input: "vin=12 r1=1k r2=2k" },
    { label: "Solve R2 for 5V from a 12V rail", input: "vin=12 vout=5 r1=10k" },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: 'Solves a two-resistor voltage divider in every direction: forward compute Vout, current, and power from R1 and R2, solve the missing resistor for a target Vout, split a total resistance budget between R1 and R2, or suggest E24 resistor pairs from Vin and Vout alone. It also models a loaded divider, showing how much Vout sags when a load resistor is added in parallel with R2, and prints a ratio table showing what this divider\'s ratio would output at common supply voltages. Input is plain text like "vin=12 r1=1k r2=2k" or "vin=12 vout=5 rtotal=10k", not a form.',
    how: 'Type values as key=value tokens separated by spaces or commas, using vin, r1, r2, vout, rtotal, or load, such as "vin=9 vout=3 r2=1k" or "vin=12 r1=1k r2=2k load=2k". The result shows every derived value in clean engineering notation, the formula used, and when solving for an unknown resistor, the exact value alongside the nearest real E24 part and the error that introduces.',
    why: "Most voltage divider calculators online only handle the forward case and ignore what happens once a real load is attached, which is exactly when a divider's output actually sags away from the number on the page. This one adds loaded-divider sag, a total-resistance-budget solver, and a ratio table across common supply rails in the same place, snapping suggested resistors to real E24 values, and your inputs never leave your device.",
    faq: [
      {
        q: "What is loaded-divider sag and why does it matter?",
        a: "A plain voltage divider only holds its calculated Vout when nothing draws current from the output node. Attaching a load resistor in parallel with R2 pulls the effective bottom resistance down, so Vout sags below the unloaded value. This matters any time the divider feeds something with real input current, like an ADC input with a low impedance or a sensor bias network, since the sag can be large enough to throw off a reading.",
      },
      {
        q: "Why does the solver suggest an E24 resistor instead of the exact calculated value?",
        a: "Resistors are only manufactured in standard E24 values, so an exact calculated resistance like 4931 ohm is not a real part. The calculator searches nearby E24 values, picks whichever one lands Vout closest to your target, and reports the resulting error percentage so you know how far off the achieved output is from the ideal.",
      },
      {
        q: "What is the ratio table for?",
        a: "A divider's output ratio, Vout divided by Vin, stays the same no matter what the supply voltage is, since it only depends on R1 and R2. The ratio table shows what that same resistor pair would output if it were instead run from other common supply rails like 3.3V, 5V, 9V, 12V, or 24V, which is useful for reusing one resistor pair across multiple projects.",
      },
    ],
  },
};
