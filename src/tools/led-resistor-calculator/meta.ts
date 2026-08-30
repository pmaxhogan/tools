import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "led-resistor-calculator",
  icon: "Zap",
  name: "LED Resistor Calculator",
  description:
    "Work out the current-limiting resistor for an LED from supply and forward voltage, with nearest E12, E24, and E96 standard values in both directions.",
  category: "Hardware",
  keywords: [
    "led resistor calculator",
    "current limiting resistor",
    "led series resistor",
    "resistor for led circuit",
    "forward voltage calculator",
    "led resistor value",
    "what resistor for led",
  ],
  searchTerms: [
    "led current limiting resistor",
    "series resistor for led",
    "e12 resistor for led",
    "e24 resistor for led",
    "e96 resistor for led",
    "led forward voltage drop",
    "resistor wattage for led",
    "how to calculate led resistor",
    "led vf calculator",
    "led circuit resistor sizing",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "color",
      label: "LED color preset",
      default: "custom",
      options: [
        {
          value: "red",
          label: "Red (1.8-2.2 V)",
          synonyms: ["standard red led", "red indicator led"],
        },
        {
          value: "green",
          label: "Green (2.0-3.0 V)",
          synonyms: ["standard green led", "green indicator led"],
        },
        {
          value: "blue-white",
          label: "Blue / white (3.0-3.4 V)",
          synonyms: ["blue led", "white led", "high brightness led"],
        },
        {
          value: "ir",
          label: "Infrared (1.2 V)",
          synonyms: ["ir led", "infrared emitter", "remote control led"],
        },
        {
          value: "uv",
          label: "Ultraviolet (3.4 V)",
          synonyms: ["uv led", "ultraviolet emitter", "blacklight led"],
        },
        {
          value: "custom",
          label: "Custom (enter vf=)",
          synonyms: ["custom forward voltage", "enter my own vf", "manual vf"],
        },
      ],
    },
  ],
  examples: [
    {
      label: "Single red LED on 9V",
      input: "vin=9 if=20mA",
      opts: { color: "red" },
    },
    {
      label: "Three white LEDs in series, custom Vf",
      input: "vin=12 vf=3.2 series=3",
      opts: { color: "custom" },
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: 'Calculates the current-limiting resistor for one or more LEDs from a supply voltage, LED forward voltage, and target current, using either a color preset or a custom forward voltage. Input is plain text like "vin=9 if=20mA" or "vin=12 vf=3.2 series=3", not a form. For every calculation it shows the nearest E12, E24, and E96 standard resistor values both at or above and at or below the exact result, each with the current, power, and recommended wattage that value actually produces.',
    how: "Pick an LED color preset, or choose custom and add a vf= token with the forward voltage from the datasheet. Then type the supply voltage as vin= and, optionally, the target current as if= (defaults to 20 mA), how many LEDs are wired in series as series=, and how many parallel resistor-and-LED strings as parallel=. The result shows the exact resistor value plus the nearest standard part in both directions across three series densities.",
    why: "Most LED resistor calculators online show only one rounded value from one series and a single direction, so you never see what happens if the nearest standard part is smaller than the exact calculation instead of larger. This one covers E12, E24, and E96 in both directions with the resulting current and power for each candidate, flags when the resistor needs more than a quarter-watt rating, and your files and inputs never leave your device.",
    faq: [
      {
        q: "Why does the calculator default the LED current to 20 mA?",
        a: "20 mA is the typical forward current for a standard 3mm or 5mm indicator LED and is a safe, commonly used target when a datasheet is not at hand. High brightness or specialty LEDs often run at a different current, so enter if= explicitly when you know the real value.",
      },
      {
        q: "Why show both a resistor at or above and one at or below the exact value?",
        a: "The at-or-above value guarantees the LED current stays at or below your target, which is the safer default. The at-or-below value runs the LED slightly brighter and draws slightly more current, which some builds prefer when the at-or-above option is a big step away from the exact calculation.",
      },
      {
        q: "What is the difference between E12, E24, and E96 resistor series?",
        a: "E12, E24, and E96 are standard sets of manufactured resistor values per decade, with 12, 24, and 96 steps respectively. E12 has widely spaced values and is common in low precision hobby parts, E24 fills in more steps, and E96 is a dense 1 percent tolerance series that gets you closest to any exact calculated value.",
      },
    ],
  },
};
