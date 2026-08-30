import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "capacitor-code-decoder",
  icon: "FileDigit",
  name: "Capacitor Code Decoder",
  description:
    "Decode 3-digit and letter capacitor codes into capacitance, tolerance, voltage rating, and reactance, or generate a code from a target value.",
  category: "Electronics",
  keywords: [
    "capacitor code decoder",
    "104 capacitor value",
    "smd capacitor code",
    "ceramic capacitor code chart",
    "capacitor tolerance letter",
    "capacitor voltage code",
    "capacitor code calculator",
  ],
  searchTerms: [
    "eia-198",
    "eia 198 capacitor code",
    "x7r meaning",
    "np0 vs c0g",
    "y5v capacitor",
    "capacitor marking chart",
    "smd cap code chart",
    "104 code capacitor",
    "capacitor reactance calculator",
    "4r7 capacitor",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Mode",
      default: "decode",
      options: [
        {
          value: "decode",
          label: "Decode code to value",
          synonyms: [
            "read capacitor",
            "code to value",
            "decode marking",
            "what value is this capacitor",
          ],
        },
        {
          value: "encode",
          label: "Encode value to code",
          synonyms: ["value to code", "encode marking", "find code", "generate capacitor code"],
        },
      ],
    },
    {
      kind: "select",
      id: "tolerance",
      label: "Tolerance (encode)",
      default: "K",
      options: [
        { value: "B", label: "B (+/-0.1 pF)", synonyms: ["b tolerance", "point one pF"] },
        { value: "C", label: "C (+/-0.25 pF)", synonyms: ["c tolerance", "point two five pF"] },
        { value: "D", label: "D (+/-0.5 pF)", synonyms: ["d tolerance", "point five pF"] },
        { value: "F", label: "F (+/-1%)", synonyms: ["f tolerance", "one percent"] },
        { value: "G", label: "G (+/-2%)", synonyms: ["g tolerance", "two percent"] },
        { value: "J", label: "J (+/-5%)", synonyms: ["j tolerance", "five percent"] },
        {
          value: "K",
          label: "K (+/-10%)",
          synonyms: ["k tolerance", "ten percent", "standard tolerance"],
        },
        { value: "M", label: "M (+/-20%)", synonyms: ["m tolerance", "twenty percent"] },
        { value: "P", label: "P (+100%/-0%)", synonyms: ["p tolerance", "plus only"] },
        { value: "Z", label: "Z (+80%/-20%)", synonyms: ["z tolerance", "loose tolerance"] },
      ],
    },
  ],
  examples: [
    { label: "104J: 100 nF, 5%", input: "104J", opts: { mode: "decode" } },
    { label: "Encode 4.7 uF", input: "4.7uF", opts: { mode: "encode", tolerance: "K" } },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Reads the 3-digit and letter codes printed on ceramic and film capacitors into capacitance, tolerance, voltage rating, and temperature coefficient, or goes the other way and turns a target capacitance into the nearest EIA-198 code. It also computes capacitive reactance at 50 Hz, 60 Hz, 1 kHz, and 1 MHz so you can see how the part behaves at real signal frequencies.",
    how: 'For decoding, switch to that mode and type the marking as printed, like "104J50V" or "104 J 50V" with the parts separated. For encoding, switch modes and type a target value with a unit, like "100nF", "0.1uF", or "220pF", then pick a tolerance letter to append. When a value cannot be represented exactly with a 3-digit code, the result reports the achieved value and the percent error.',
    why: "Most capacitor code lookups are static reference charts with no calculator behind them, and none compute reactance at the same time. This one decodes and encodes in one place, explains the digit-9 exception that trips up most manual lookups, and your inputs never leave your device.",
    faq: [
      {
        q: "What does the third digit mean when it is a 9, like in 229?",
        a: "Digits 0 through 8 as the third digit mean multiply the first two significant digits by 10 raised to that digit, in picofarads. Digit 9 is the one documented exception in EIA-198: it means multiply by 0.1 instead, so 229 decodes as 22 x 0.1 pF, or 2.2 pF, not 22 billion picofarads.",
      },
      {
        q: "What is the difference between NP0, C0G, and X7R?",
        a: "NP0 and C0G are the same temperature coefficient class under two different naming standards; both describe an ultra-stable ceramic dielectric with almost no capacitance drift over temperature, ideal for RF and timing circuits. X7R is a different, higher-capacitance-density dielectric that trades that stability for size, drifting up to 15 percent over its rated temperature range.",
      },
      {
        q: "Can I trust the voltage rating code table exactly?",
        a: "Treat it as a common convention rather than a locked standard. The two-character voltage codes (like 1E for 25 V) are widely used but manufacturers are not perfectly consistent about them, so always check the datasheet or the case markings directly when a design depends on the exact voltage rating.",
      },
    ],
  },
};
