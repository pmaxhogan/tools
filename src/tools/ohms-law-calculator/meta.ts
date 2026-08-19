import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "ohms-law-calculator",
  matrixSlug: "ohms-law",
  icon: "CircuitBoard",
  name: "Ohm's Law & LED Calculator",
  description: "Solve voltage, current, resistance, and power, plus LED resistor and voltage divider math.",
  category: "Hardware",
  keywords: [
    "ohms law calculator",
    "led resistor calculator",
    "voltage divider calculator",
    "resistor calculator",
    "current limiting resistor",
  ],
  searchTerms: [
    "v i r calculator",
    "watts law calculator",
    "led forward voltage calculator",
    "e24 resistor calculator",
    "e12 resistor calculator",
    "series led resistor",
    "voltage divider resistor",
    "power dissipation calculator",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Calculation",
      default: "ohms-law",
      options: [
        {
          value: "ohms-law",
          label: "Ohm's Law (V, I, R, P)",
          synonyms: ["voltage current resistance power", "basic", "vir", "watts law"],
        },
        {
          value: "led-resistor",
          label: "LED current limiting resistor",
          synonyms: ["led resistor", "forward voltage", "series resistor", "resistor for led"],
        },
        {
          value: "voltage-divider",
          label: "Voltage divider",
          synonyms: ["resistor divider", "r1 r2", "divider network", "potential divider"],
        },
      ],
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Solves Ohm's law and power for voltage, current, resistance, and power given any two of them, sizes a current limiting resistor for one or more series LEDs against the E12 and E24 standard series, and solves voltage divider networks in either direction. Input is plain text like \"12V 100mA\" or \"vin=12 vf=2.1 if=20mA\", not a form.",
    how: "Pick a calculation mode, then type values as key=value pairs or number-plus-unit tokens separated by spaces or commas, such as \"R=4.7k P=2W\" or \"vin=9 vout=3 r2=1k\". The result shows every derived value in clean engineering notation along with the formula used and, for LEDs and dividers, the nearest standard resistor values.",
    why: "Most online Ohm's law calculators handle only one mode, force you into separate input boxes per variable, and round LED resistor suggestions to arbitrary values instead of real E12 or E24 parts. This one takes free-form text, covers all three common calculations in one place, and your inputs never leave your device.",
    faq: [
      {
        q: "Why does it suggest a resistor value above the exact calculation instead of the exact value?",
        a: "Resistors are only manufactured in standard E12 or E24 values. Rounding up guarantees the LED current stays at or below your target, since a larger resistor lowers current; rounding down would risk over driving the LED.",
      },
      {
        q: "What wattage resistor do I actually need?",
        a: "The calculator computes the resistor's real power dissipation for the suggested value and recommends the next standard rating (1/8W, 1/4W, 1/2W, 1W, 2W, or 5W) that gives at least double that dissipation as safety headroom.",
      },
      {
        q: "Should LEDs be wired in series or parallel with one resistor?",
        a: "Series with one resistor sized for the combined forward voltage is standard practice; wiring LEDs in parallel behind a single resistor is unreliable because slight forward voltage differences make one LED hog the current.",
      },
    ],
  },
};
