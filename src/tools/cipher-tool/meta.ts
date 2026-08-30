import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "cipher-tool",
  icon: "LockKeyhole",
  name: "Cipher Tool",
  description:
    "Encode and decode text with Caesar, ROT13, ROT47, Atbash, Vigenere, Affine, and Rail fence ciphers, plus a Caesar brute force scanner.",
  category: "Text",
  keywords: [
    "cipher tool",
    "caesar cipher",
    "rot13 converter",
    "rot47 converter",
    "vigenere cipher",
    "atbash cipher",
    "affine cipher",
    "rail fence cipher",
  ],
  searchTerms: [
    "caesar cipher decoder",
    "caesar cipher brute force",
    "letter shift cipher",
    "polyalphabetic cipher",
    "classical cipher tool",
    "cryptogram solver",
    "substitution cipher",
    "transposition cipher",
    "affine cipher decoder",
    "text encryption tool",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "cipher",
      label: "Cipher",
      default: "caesar",
      options: [
        { value: "caesar", label: "Caesar shift", synonyms: ["shift cipher", "letter shift"] },
        { value: "rot13", label: "ROT13", synonyms: ["rotate 13"] },
        { value: "rot47", label: "ROT47", synonyms: ["rotate 47", "ascii rotation"] },
        { value: "atbash", label: "Atbash", synonyms: ["reverse alphabet cipher"] },
        {
          value: "vigenere",
          label: "Vigenere",
          synonyms: ["polyalphabetic cipher", "keyword cipher"],
        },
        { value: "affine", label: "Affine", synonyms: ["linear cipher", "a b cipher"] },
        {
          value: "railfence",
          label: "Rail fence",
          synonyms: ["zigzag cipher", "transposition cipher"],
        },
      ],
    },
    {
      kind: "select",
      id: "mode",
      label: "Mode",
      default: "encode",
      ui: "segmented",
      options: [
        { value: "encode", label: "Encode", synonyms: ["encrypt"] },
        { value: "decode", label: "Decode", synonyms: ["decrypt"] },
      ],
    },
    {
      kind: "text",
      id: "key",
      label: "Shift / key",
      default: "3",
      placeholder: 'Caesar and rail fence: a number. Vigenere: a word. Affine: "a,b" like "5,8".',
    },
    {
      kind: "boolean",
      id: "bruteForce",
      label: "Brute force all 26 Caesar shifts",
      default: false,
    },
  ],
  examples: [
    { label: "Caesar shift 3", input: "Attack at dawn" },
    { label: "Vigenere", input: "ATTACKATDAWN", opts: { cipher: "vigenere", key: "LEMON" } },
    {
      label: "Brute force an unknown Caesar shift",
      input: "Dwwdfn dw gdzq",
      opts: { bruteForce: "true" },
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Encodes and decodes text with seven classical ciphers: Caesar shift, ROT13, ROT47, Atbash, Vigenere, Affine, and Rail fence transposition. A brute force mode ignores the cipher and key settings and tries every one of the 26 possible Caesar shifts at once, scoring each candidate by how many common English words it contains, so you can crack an unknown Caesar-shifted message without knowing the key.",
    how: 'Paste your text, pick a cipher, and choose Encode or Decode. Enter a shift number for Caesar and Rail fence, a keyword for Vigenere, or two numbers like "5,8" for Affine\'s a and b values. Flip on brute force to instead see all 26 Caesar shift candidates ranked by how English-like each one reads, with the best guess called out.',
    why: "Most cipher tools online cover Caesar and ROT13 and stop there, or give you encode without decode. This one covers seven ciphers in both directions plus a real brute force scanner that scores candidates against actual English word frequency, all client-side with no ads: your files and inputs never leave your device.",
    faq: [
      {
        q: "How does the brute force Caesar scanner decide the best guess?",
        a: 'It decodes the ciphertext with all 26 possible shifts, counts how many common English words (like "the," "and," "of") appear in each result, and ranks candidates by that count, falling back to a chi-squared letter-frequency comparison to break ties. This is far more reliable on short messages than scoring by raw letter frequency alone.',
      },
      {
        q: "What key format does the Affine cipher expect?",
        a: 'Two numbers separated by a comma, like "5,8," representing a and b in the formula E(x) = (a times x plus b) mod 26. The a value must be coprime with 26 (odd and not a multiple of 13), such as 1, 3, 5, 7, 9, 11, 15, 17, 19, 21, 23, or 25, or the cipher has no valid inverse for decoding.',
      },
      {
        q: "Why do ROT13 and ROT47 not need a mode setting?",
        a: "Both are self-inverse: applying the same 13-letter or 47-position rotation twice returns the original text, so encoding and decoding are the identical operation. The mode selector still shows for consistency with the other ciphers, but it has no effect on the result for these two.",
      },
    ],
  },
};
