import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "mojibake-fixer",
  icon: "WandSparkles",
  matrixSlug: "mojibake",
  name: "Mojibake Fixer",
  description: "Repair garbled text like Ã© and â€™ back to the UTF-8 it was meant to be.",
  category: "Text",
  keywords: [
    "mojibake fixer",
    "fix garbled text",
    "Ã© to é",
    "â€™ apostrophe fix",
    "utf-8 encoding repair",
    "double encoded utf-8",
    "ftfy online",
    "fix broken characters in csv",
  ],
  searchTerms: [
    "ftfy alternative",
    "fix character encoding",
    "windows-1252 vs utf-8",
    "latin1 encoding fix",
    "garbled csv text",
    "weird symbols instead of accents",
    "encoding mismatch fix",
    "repair unicode text",
    "question marks instead of characters",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "chain",
      label: "Encoding chain",
      default: "auto",
      options: [
        {
          value: "auto",
          label: "Auto detect",
          synonyms: ["automatic", "guess", "best guess", "default"],
        },
        {
          value: "cp1252-once",
          label: "UTF-8 read as Windows-1252 (once)",
          synonyms: ["windows-1252", "ansi", "cp-1252", "single encoded"],
        },
        {
          value: "cp1252-twice",
          label: "UTF-8 read as Windows-1252 (twice)",
          synonyms: ["windows-1252", "ansi", "cp-1252", "double encoded"],
        },
        {
          value: "latin1-once",
          label: "UTF-8 read as Latin-1 (once)",
          synonyms: ["iso-8859-1", "iso 8859-1", "single encoded"],
        },
        {
          value: "latin1-twice",
          label: "UTF-8 read as Latin-1 (twice)",
          synonyms: ["iso-8859-1", "iso 8859-1", "double encoded"],
        },
      ],
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Repairs mojibake: UTF-8 text that some program decoded with a legacy single byte encoding, turning é into Ã© and a curly apostrophe into â€™. Paste the garbled text and the tool re-encodes it with Windows-1252 or Latin-1, decodes the resulting bytes as strict UTF-8, and shows the version that comes out clean. It handles double encoded text (two rounds of damage) and mixed chains, strips a leading byte order mark that arrived as ï»¿, and tells you which chain it applied and how confident it is.",
    how: "Paste or drop the broken text into the input box. Leave the chain on Auto detect and the tool scores every realistic repair path, including doing nothing, then keeps the best one. If you already know what happened, pick the exact chain from the dropdown: the tool applies only that one and says plainly when it does not fit. Copy the fixed text from its row, and share the URL to hand someone the exact result.",
    why: "The reference fixer, ftfy, is a Python library, so using it means installing Python or pasting your data into someone else's web form. The web alternatives usually try one chain, give up quietly, and wrap the answer in ads. This one tries every realistic chain including double encoding, refuses to mangle text that is already clean, names the chain it used, and runs entirely in your browser, so your files and inputs never leave your device.",
    faq: [
      {
        q: "What causes mojibake in the first place?",
        a: "A file is written as UTF-8, then read back by a program that assumes a legacy single byte encoding such as Windows-1252 or Latin-1. Each UTF-8 byte becomes its own character, so one accented letter turns into two or three odd looking ones. Exporting a spreadsheet to CSV, importing it somewhere with the wrong encoding setting, and old database columns declared as latin1 are the usual sources.",
      },
      {
        q: "What does â€™ actually mean?",
        a: "It is a right single quotation mark (U+2019), the curly apostrophe. In UTF-8 that character is the three bytes E2 80 99. Read as Windows-1252 those bytes become â, the euro sign, and the trademark sign, which is exactly the â€™ you see. Re-encoding those three characters back to bytes and decoding as UTF-8 restores the apostrophe.",
      },
      {
        q: "Can it fix every case?",
        a: "No. If the damaging step dropped bytes, the original characters are gone and no tool can recover them. That happens when text passes through an encoding that has no byte for some character, or through a converter that replaced unknown bytes with question marks or U+FFFD. This tool allows a small tolerance for lost characters, marks those results as partial, and reports low confidence rather than guessing.",
      },
    ],
  },
};
