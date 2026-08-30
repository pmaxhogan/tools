import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "555-timer-calculator",
  icon: "Timer",
  name: "555 Timer Calculator",
  description:
    "Calculate astable and monostable 555 timer frequency, duty cycle, pulse width, and component values, with a wiring sketch.",
  category: "Electronics",
  keywords: [
    "555 timer calculator",
    "astable calculator",
    "monostable calculator",
    "ne555 frequency calculator",
    "555 duty cycle",
    "555 timer frequency",
    "555 timer pulse width",
  ],
  searchTerms: [
    "ne555 calculator",
    "tlc555 calculator",
    "icm7555 calculator",
    "555 astable frequency",
    "555 monostable pulse width",
    "resistor capacitor timer calculator",
    "555 timer resistor calculator",
    "555 timer duty cycle calculator",
    "oscillator 555 calculator",
    "one shot timer calculator",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Circuit",
      default: "astable",
      options: [
        {
          value: "astable",
          label: "Astable (oscillator)",
          synonyms: ["free running", "square wave", "oscillator", "repeating pulse"],
        },
        {
          value: "monostable",
          label: "Monostable (one shot)",
          synonyms: ["one shot", "single pulse", "trigger delay", "pulse generator"],
        },
      ],
    },
    {
      kind: "select",
      id: "chip",
      label: "Chip family",
      default: "bipolar",
      options: [
        {
          value: "bipolar",
          label: "Bipolar (NE555)",
          synonyms: ["ne555", "se555", "bipolar 555", "classic 555"],
        },
        {
          value: "cmos",
          label: "CMOS (TLC555 / ICM7555)",
          synonyms: ["tlc555", "icm7555", "cmos 555", "low power 555"],
        },
      ],
    },
  ],
  examples: [
    {
      label: "1 kHz astable from R1/R2/C",
      input: "r1=10k r2=4.7k c=10n",
      opts: { mode: "astable" },
    },
    {
      label: "10ms monostable pulse",
      input: "r=100k w=10m",
      opts: { mode: "monostable" },
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: 'Calculates a 555 timer astable oscillator (frequency, period, high and low time, duty cycle) or a monostable one shot pulse width, either forward from component values or solved backward from a target frequency, duty cycle, or pulse width. Input is plain text like "r1=10k r2=4.7k c=10n" or "freq=1k duty=60", not a form, and the result includes a correct pin out wiring sketch.',
    how: "Pick astable or monostable and a chip family, then type values as key=value tokens separated by spaces or commas. Astable accepts r1, r2, and c for a direct calculation, or freq and duty to solve for R1 and R2 against the nearest standard E24 resistor values. Monostable accepts r and c directly, or a target pulse width w with either r or c given to solve for the other.",
    why: "Most 555 calculators online only handle the forward direction and skip the fact that a diode free astable circuit can never hit 50 percent duty cycle or below, which trips up a lot of first time designs. This one solves in both directions, snaps solved resistor and capacitor values to real E24 parts, explains the bipolar versus CMOS tradeoff, and your inputs never leave your device.",
    faq: [
      {
        q: "Why can a standard 555 astable circuit not produce a duty cycle of 50 percent or less?",
        a: "In the classic three component astable (R1 to the discharge pin, R2 to the timing capacitor, no diode), the capacitor always charges through R1 plus R2 but only discharges through R2. The high time is therefore always at least as long as the low time, so duty cycle is always above 50 percent. Getting 50 percent or below needs a diode across R1, which this calculator does not model.",
      },
      {
        q: "What is the real difference between a bipolar NE555 and a CMOS 555 like the TLC555?",
        a: "The astable and monostable timing formulas are identical for both, since they come from the RC charge and discharge topology, not the chip's internal transistor type. What differs is supply range, output swing, and power draw: a bipolar NE555 needs a higher minimum voltage and draws more idle current, while a CMOS 555 runs on a wider voltage range, swings its output closer to the rails, and draws far less current at idle.",
      },
      {
        q: "What does the wiring sketch show?",
        a: "It is a text pin out diagram of the standard 555 astable or monostable circuit showing where R1, R2 (or R), and C connect relative to the discharge, threshold, trigger, and output pins, plus the usual reset tied to Vcc and the optional 10 nF control voltage bypass capacitor, so you can check your breadboard or schematic against a known good layout.",
      },
    ],
  },
};
