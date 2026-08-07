import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "base-converter",
  icon: "Binary",
  matrixSlug: "base-convert",
  name: "Base Converter",
  description: "Binary, octal, decimal and hex with a bitwise visualiser.",
  category: "Text",
  keywords: [
    "base converter",
    "binary to decimal",
    "hex converter",
    "decimal to binary",
    "octal converter",
    "base36 converter",
    "bitwise visualizer",
  ],
  searchTerms: [
    "hex to decimal",
    "decimal to hex",
    "binary converter",
    "radix",
    "number base",
    "dec to hex",
    "bin to dec",
    "hex to binary",
    "binary to hex",
    "number system converter",
    "twos complement",
    "nibble viewer",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "inputBase",
      label: "Input base",
      default: "auto",
      options: [
        {
          value: "auto",
          label: "Auto-detect (0x/0b/0o prefix, else decimal)",
          synonyms: ["automatic", "detect base", "guess base"],
        },
        { value: "2", label: "Binary (2)", synonyms: ["bin", "base 2", "0b"] },
        { value: "8", label: "Octal (8)", synonyms: ["oct", "base 8", "0o"] },
        { value: "10", label: "Decimal (10)", synonyms: ["dec", "base 10", "denary"] },
        { value: "16", label: "Hexadecimal (16)", synonyms: ["hex", "base 16", "0x"] },
        { value: "36", label: "Base 36", synonyms: ["alphanumeric base", "radix 36"] },
      ],
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Converts integers between binary, octal, decimal, hexadecimal and base 36, using arbitrary-precision arithmetic so numbers of any size (not just 32 or 64 bit) round-trip exactly. Recognizes 0x, 0b and 0o prefixes automatically, or you can force a specific input base. Every result also shows a nibble-grouped bit pattern, the bit length, and the raw hex bytes for values that fit in 64 bits.",
    how: "Type or paste a number (with or without a base prefix like 0xFF, 0b1010 or 0o17) and every base updates at once. Pick an input base from the dropdown if your number is unprefixed and not decimal. Negative numbers are supported; each output row has its own copy button.",
    why: "Most base converters cap out at 32-bit integers and silently overflow on anything larger. This one uses BigInt throughout, so a 128-bit or 256-bit value converts exactly, with no ads and nothing sent off your device.",
    faq: [
      {
        q: "Does it handle numbers bigger than 64 bits?",
        a: 'Yes, conversion uses BigInt, so values of arbitrary size (128-bit, 256-bit, or larger) convert exactly. The "Bytes" row only appears for values that fit in 64 bits, since it exists for quick byte-level inspection.',
      },
      {
        q: "How are negative numbers represented?",
        a: 'As a sign followed by the magnitude in the target base (e.g. -0xff), not two\'s complement. The "Bits" row is the bit length of the magnitude alone.',
      },
      {
        q: "What happens if I paste an invalid digit for the selected base?",
        a: 'You get an error naming the exact character and its position in your input, such as an "8" in a binary number, so you can fix it immediately.',
      },
    ],
  },
};
