import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "number-to-words",
  icon: "Sigma",
  name: "Number to Words",
  description:
    "Spell out a number in English words, including negative, decimal, ordinal, and currency forms, or convert words back into a number.",
  category: "Text",
  keywords: [
    "number to words",
    "number to words converter",
    "spell out a number",
    "check writing amount",
    "number in words",
    "words to number",
    "ordinal number converter",
    "currency to words",
  ],
  searchTerms: [
    "how to write a number in words",
    "check amount in words",
    "cardinal number spelling",
    "ordinal number spelling",
    "dollar amount in words",
    "euro amount in words",
    "pound amount in words",
    "vigintillion converter",
    "large number to words",
    "convert words to number",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "currency",
      label: "Currency",
      default: "none",
      ui: "segmented",
      options: [
        { value: "none", label: "None", synonyms: ["plain number", "cardinal"] },
        { value: "usd", label: "USD ($)", synonyms: ["dollars", "us dollar"] },
        { value: "eur", label: "EUR (€)", synonyms: ["euros"] },
        { value: "gbp", label: "GBP (£)", synonyms: ["pounds", "sterling"] },
      ],
    },
    {
      kind: "boolean",
      id: "checkStyle",
      label: "Check-writing style (and 45/100)",
      default: false,
    },
    { kind: "boolean", id: "ordinal", label: "Ordinal (first, second, third)", default: false },
  ],
  examples: [
    { label: "Whole number", input: "1234" },
    { label: "Check amount", input: "123.45", opts: { currency: "usd", checkStyle: "true" } },
    { label: "Words back to a number", input: "one thousand two hundred thirty-four" },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: 'Spells out a number in English words, or parses number words back into a number, auto-detecting the direction. Handles negative numbers, decimals (spelled digit by digit after "point"), ordinal forms ("twenty-first"), and currency amounts in USD, EUR, or GBP, including the "and 45/100 dollars" style used when writing a check by hand. Integers are supported up to vigintillion, 10 to the 63rd power, using every short-scale name in between.',
    how: 'Type a number to spell it out, or paste number words like "one thousand two hundred thirty-four" to parse them back into a number. Turn on a currency to get dollar, euro, or pound amounts with cents or pence spelled out, and turn on check-writing style for the fraction-over-100 format banks expect. The ordinal toggle converts the result to first, second, third, and so on.',
    why: "Most number-to-words tools cap out in the millions or billions, skip ordinals and check-writing format entirely, and only go one direction. This one covers negative numbers, decimals, three currencies, check-writing format, ordinals, and numbers up to vigintillion, plus a words-to-number reverse mode, all client-side with no ads: your files and inputs never leave your device.",
    faq: [
      {
        q: "How large a number can this tool spell out?",
        a: "Up to just under a thousand vigintillion, the largest short-scale name this tool knows, which is 10 to the 63rd power. That covers every named short-scale magnitude in between: thousand, million, billion, trillion, and eighteen more all the way through vigintillion.",
      },
      {
        q: "How does check-writing style differ from the regular currency format?",
        a: 'Regular currency style spells out both the whole amount and the cents, like "one hundred twenty-three dollars and forty-five cents." Check-writing style spells out only the whole amount and writes the cents as a fraction over 100, like "one hundred twenty-three and 45/100 dollars," matching how banks expect a check to be filled out by hand.',
      },
      {
        q: "How are decimal numbers that are not currency spelled out?",
        a: 'Decimals spell out digit by digit after the word "point," so 3.14 becomes "three point one four" rather than being read as a fraction. This matches how numbers like pi or measurements are normally read aloud.',
      },
    ],
  },
};
