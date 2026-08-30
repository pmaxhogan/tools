import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "dbm-watts-volts",
  matrixSlug: "dbm-watts-volts-converter",
  icon: "Zap",
  name: "dBm, Watts, and Volts Converter",
  description:
    "Convert RF power between dBm, dBW, watts, Vrms, Vpp, and dBuV across 50, 75, or 600 ohm impedances, with a reference table.",
  category: "RF",
  keywords: [
    "dbm to watts calculator",
    "dbm converter",
    "watts to dbm calculator",
    "rf power converter",
    "vrms to dbm calculator",
    "dbuv converter",
    "power to voltage calculator",
  ],
  searchTerms: [
    "dbm calculator",
    "dbw calculator",
    "rf power units",
    "0dbm to mw",
    "30dbm to watts",
    "vpp to vrms",
    "voltage to power 50 ohm",
    "microvolt to dbuv",
    "signal strength converter",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "impedance",
      label: "Reference impedance",
      default: "50",
      options: [
        { value: "50", label: "50 ohm", synonyms: ["50", "rf coax", "antenna feedline"] },
        { value: "75", label: "75 ohm", synonyms: ["75", "video", "cable tv", "broadcast"] },
        { value: "600", label: "600 ohm", synonyms: ["600", "audio line", "telephone"] },
      ],
    },
  ],
  examples: [
    { label: "30 dBm to watts and volts", input: "30dBm" },
    { label: "100 mW to dBm", input: "100mW" },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Converts a single RF power or voltage figure, entered as dBm, dBW, watts (with SI prefixes like mW or uW), Vrms, Vpp, or dBuV, into all the others at once, at a chosen reference impedance of 50, 75, or 600 ohm. A reference table of common dBm values is always shown alongside for a quick sanity check.",
    how: 'Type a value with its unit attached, like "30dBm", "100mW", "0.1Vrms", or "10Vpp", and pick the reference impedance the voltage figures should use. The result shows the same signal expressed in every supported unit, plus the reference table.',
    why: "Most dBm converters handle only power, forcing you to a second site for the voltage side of the same signal. This one covers power and voltage together, including the less common dBuV unit used in EMC and receiver sensitivity work, at whatever impedance your system actually uses, and your inputs never leave your device.",
    faq: [
      {
        q: "Why does the same dBm value give a different Vrms depending on impedance?",
        a: "dBm is a measure of power, and power at a given voltage depends on impedance (P = V^2 / R), so the same power delivers a higher voltage into a higher impedance. 0 dBm (1 mW) is about 0.224 Vrms into 50 ohm but about 0.775 Vrms into 600 ohm, which is why 600 ohm is the traditional reference for audio dBm figures and 50 ohm is standard for RF.",
      },
      {
        q: "What is dBuV and where is it used?",
        a: "dBuV expresses a voltage relative to 1 microvolt, so 0 dBuV is 1 uV and 120 dBuV is 1 Vrms. It shows up in receiver sensitivity specifications, EMC compliance testing, and broadcast field strength measurements, where signals are often small enough that dBm figures would be deeply negative and less intuitive.",
      },
      {
        q: "Is Vpp the same as Vrms times 2?",
        a: "No. For a sine wave, peak to peak voltage is Vrms multiplied by 2 times the square root of 2, about 2.828, not simply 2. This tool assumes a sine wave when converting between Vpp and Vrms, which is the standard assumption for RF signals but not correct for other waveforms like square waves.",
      },
    ],
  },
};
