import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "roman-numeral-converter",
  icon: "ScrollText",
  name: "Roman Numeral Converter",
  description:
    "Convert between whole numbers and Roman numerals in either direction, with strict canonical validation and vinculum notation above 3999.",
  category: "Text",
  keywords: [
    "roman numeral converter",
    "roman numerals to numbers",
    "numbers to roman numerals",
    "roman numeral translator",
    "convert roman numerals",
    "roman numeral chart",
    "roman numeral generator",
    "mcmxciv converter",
  ],
  searchTerms: [
    "roman numeral date converter",
    "roman numeral calculator",
    "vinculum notation",
    "roman numeral above 3999",
    "roman numeral validator",
    "canonical roman numeral",
    "roman numeral rules",
    "nulla zero roman numeral",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    { kind: "boolean", id: "strict", label: "Strict canonical validation", default: true },
    {
      kind: "boolean",
      id: "useVinculum",
      label: "Vinculum overline above 3999",
      default: false,
    },
  ],
  examples: [
    { label: "Number to Roman", input: "1994" },
    { label: "Roman to number", input: "MCMXCIV" },
    { label: "Large number with a vinculum", input: "4783", opts: { useVinculum: "true" } },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Converts between whole numbers and Roman numerals automatically in either direction, from 0 (written N, the medieval nulla) up to 3,999,999. Roman-to-number decoding includes a strict mode that rejects non-canonical forms like IIII for 4 or VX for 5, and a lenient mode that accepts them. Numbers at or above 4000 render either as repeated M characters or, with the vinculum option, as an overlined thousands digit worth a thousand times its normal value, the classical Roman way of extending the numeral system past 3999.",
    how: "Type a whole number to get its Roman numeral, or paste Roman numeral letters to get the number back: the tool detects which one you typed. Toggle strict mode to require the textbook-canonical spelling, and toggle the vinculum option to render numbers of 4000 or more with an overline instead of a long run of M characters. A breakdown line under the result shows exactly how each symbol contributed to the total.",
    why: "Most Roman numeral converters only go one direction, silently accept malformed input like IIII or IIX, and stop at 3999 with no explanation. This one converts both ways, validates canonical form on request, supports classical vinculum notation for large numbers, and shows a symbol-by-symbol breakdown, all client-side with no ads: your files and inputs never leave your device.",
    faq: [
      {
        q: "Why does strict mode reject IIII for the number 4?",
        a: "Classical and modern Roman numeral convention writes 4 using subtractive notation as IV, not four repeated I characters. Strict mode re-derives the canonical spelling for the decoded value and rejects any input that does not match it exactly, while lenient mode still sums IIII correctly as 4 without complaint.",
      },
      {
        q: "What is a vinculum and why does it matter above 3999?",
        a: "A vinculum is a horizontal line drawn over a numeral to multiply its value by 1000, the standard classical way to extend Roman numerals past their normal 3999 ceiling (since M can only repeat so many times before it gets unwieldy). With the vinculum option on, 4783 renders as an overlined IV for 4000 followed by DCCLXXXIII for the remaining 783.",
      },
      {
        q: "What does N mean in the output?",
        a: "N stands for nulla, the word medieval scholars used for zero since the classical Roman numeral system had no symbol for it. This tool accepts and produces N as the Roman form of 0 in both directions.",
      },
    ],
  },
};
