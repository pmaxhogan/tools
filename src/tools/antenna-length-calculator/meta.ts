import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "antenna-length-calculator",
  icon: "Radio",
  name: "Antenna Length Calculator",
  description:
    "Full wave, half-wave dipole, quarter-wave vertical, and 5/8 wave antenna lengths for any frequency, plus a 3 element Yagi starter.",
  category: "RF",
  keywords: [
    "antenna length calculator",
    "dipole antenna calculator",
    "quarter wave antenna calculator",
    "half wave dipole length",
    "5/8 wave antenna calculator",
    "yagi antenna calculator",
    "ham radio antenna length",
  ],
  searchTerms: [
    "468/f antenna formula",
    "234/f antenna formula",
    "143/f dipole formula",
    "j pole length",
    "vertical antenna length",
    "dipole cut length",
    "antenna wavelength calculator",
    "3 element yagi dimensions",
    "wire antenna length",
    "tubing antenna length",
    "velocity factor antenna",
    "per leg dipole length",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Antenna type",
      default: "half-wave-dipole",
      options: [
        {
          value: "half-wave-dipole",
          label: "Half-wave dipole",
          synonyms: ["dipole", "468/f", "143/f", "center fed dipole"],
        },
        {
          value: "quarter-wave-vertical",
          label: "Quarter-wave vertical",
          synonyms: ["234/f", "ground plane", "monopole", "vertical antenna"],
        },
        {
          value: "five-eighth-wave",
          label: "5/8 wave vertical",
          synonyms: ["5/8 wave", "0.625 wave", "gain vertical"],
        },
        {
          value: "full-wave",
          label: "Full wave",
          synonyms: ["one wavelength", "full wave loop", "full wave antenna"],
        },
        {
          value: "yagi-3-element",
          label: "3 element Yagi starter",
          synonyms: ["yagi", "beam antenna", "reflector director", "driven element"],
        },
      ],
    },
    {
      kind: "select",
      id: "conductor",
      label: "Conductor",
      default: "wire",
      options: [
        { value: "wire", label: "Wire (velocity factor 0.95)", synonyms: ["wire antenna", "0.95"] },
        {
          value: "tubing",
          label: "Tubing (velocity factor 0.98)",
          synonyms: ["aluminum tubing", "0.98", "boom"],
        },
      ],
    },
    {
      kind: "number",
      id: "customVf",
      label: "Custom velocity factor (0 uses the conductor preset)",
      default: 0,
      min: 0,
      max: 1,
      step: 0.001,
    },
  ],
  examples: [
    { label: "2m half-wave dipole", input: "146.52 MHz", opts: { mode: "half-wave-dipole" } },
    {
      label: "40m quarter-wave vertical",
      input: "7.1 MHz",
      opts: { mode: "quarter-wave-vertical" },
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: 'Computes the physical length of a wire or tubing antenna for a given frequency: full wave, half-wave dipole (with per leg length), quarter-wave vertical, 5/8 wave vertical, and a 3 element Yagi starter with reflector, director, and boom spacing. Input is a frequency like "146.52 MHz" or "7.1MHz"; a bare number is read as MHz.',
    how: "Type a frequency, pick the antenna type, and choose wire or tubing (or override with a custom velocity factor from 0 to 1). Results show length in meters and centimeters alongside feet and inches, plus the classic ham radio reference formulas (468/f, 234/f, 143/f) for comparison.",
    why: "Most antenna length calculators only do the half-wave dipole and hide the math behind a single hardcoded constant. This one derives every length from the speed of light and your chosen velocity factor, covers five common antenna types including a Yagi starter, shows both metric and imperial output, and your inputs never leave your device.",
    faq: [
      {
        q: "Why does my cut length differ slightly from the 468/f formula?",
        a: "The 468/f (feet) and 143/f (meters) constants already bake in an assumed 0.95 wire velocity factor and some rounding. This calculator computes the length directly from the speed of light and your chosen velocity factor, so it tracks closer to the physics; the classic formula is still shown alongside for reference and the two normally agree within a percent or two.",
      },
      {
        q: "What velocity factor should I use?",
        a: "Thin wire antennas typically use 0.95 to 0.96 because end effects and wire diameter shorten the resonant length below the free space value. Thicker tubing elements, common on Yagis and verticals, run closer to 0.97 to 0.98 because a fatter conductor has less end effect per unit length. These are starting points: real world tuning (SWR analyzer, trimming) always wins over any formula.",
      },
      {
        q: "Who is allowed to transmit on the frequency I am designing for?",
        a: "This tool only computes physical dimensions; it does not check licensing. For who may legally transmit on a given frequency, see the Electromagnetic Spectrum tool, which includes the US allocation chart and amateur radio band privileges by license class.",
      },
    ],
  },
};
