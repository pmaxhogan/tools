import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "nato-phonetic-alphabet",
  icon: "Mic",
  name: "NATO Phonetic Alphabet",
  description:
    "Spell out any text using the NATO phonetic alphabet, or three other military and telecom spelling alphabets, in either direction.",
  category: "Text",
  keywords: [
    "nato phonetic alphabet",
    "military alphabet",
    "phonetic alphabet translator",
    "alfa bravo charlie",
    "spelling alphabet",
    "radio alphabet",
    "phonetic alphabet converter",
    "aviation alphabet",
  ],
  searchTerms: [
    "icao alphabet",
    "police phonetic alphabet",
    "letter spelling alphabet",
    "able baker charlie",
    "us army phonetic alphabet",
    "german buchstabiertafel",
    "italian phonetic alphabet",
    "swedish phonetic alphabet",
    "radio spelling code",
    "call sign alphabet",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "alphabet",
      label: "Alphabet",
      default: "nato",
      options: [
        {
          value: "nato",
          label: "NATO / ICAO (Alfa, Bravo, Charlie)",
          synonyms: ["international", "aviation", "standard", "military alphabet"],
        },
        {
          value: "us-army",
          label: "US Army legacy (Able, Baker, Charlie)",
          synonyms: ["world war 2", "joint army navy", "1940s", "able baker charlie"],
        },
        {
          value: "german",
          label: "German (Anton, Berta, Casar)",
          synonyms: ["buchstabiertafel", "deutsch", "germany"],
        },
        {
          value: "italian",
          label: "Italian (Ancona, Bologna, Como)",
          synonyms: ["alfabeto telefonico", "italy", "italiano"],
        },
        {
          value: "swedish",
          label: "Swedish (Adam, Bertil, Cesar)",
          synonyms: ["sverige", "sweden", "svenska"],
        },
      ],
    },
    {
      kind: "select",
      id: "digitStyle",
      label: "Digit style",
      default: "standard",
      ui: "segmented",
      options: [
        { value: "standard", label: "Standard (Three, Nine)", synonyms: ["normal", "english"] },
        {
          value: "aviation",
          label: "Aviation (Tree, Niner)",
          synonyms: ["icao", "radio pronunciation"],
        },
      ],
    },
  ],
  examples: [
    { label: "Spell out SOS", input: "SOS" },
    { label: "Decode phonetic words", input: "Alfa Bravo Charlie" },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Spells out text letter by letter using the NATO/ICAO phonetic alphabet, the World War 2 era US Army legacy alphabet, or the classic German, Italian, or Swedish spelling alphabets, and decodes phonetic words back into letters in the other direction. Digits can spell out as standard English words or ICAO aviation pronunciations (Tree, Fower, Fife, Niner) for radio clarity.",
    how: 'Type any text and it spells out using the selected alphabet, with a word by word breakdown below the main result. Paste phonetic words instead, like "Sierra Oscar Sierra," and it decodes back to letters automatically. Switch alphabets or digit style any time; the output updates instantly.',
    why: "Most phonetic alphabet tools only cover the NATO standard and only go one direction. This one covers five alphabets used across military, telecom, and radio contexts, decodes as well as encodes, and shows the letter by letter breakdown so you can check the spelling, all client-side with no ads: your files and inputs never leave your device.",
    faq: [
      {
        q: "How does the tool decide whether to spell text out or decode it?",
        a: 'It checks how many of the space separated words in your input match a known phonetic or digit word for the selected alphabet. If most of them match, like "Alfa Bravo Charlie," it decodes; otherwise it treats the input as plain text and spells it out.',
      },
      {
        q: "What is the US Army legacy alphabet?",
        a: 'The Joint Army/Navy Phonetic Alphabet used by US forces from the early 1940s until NATO standardized Alfa, Bravo, Charlie in 1956. It is the source of the phrase "Able Baker Charlie" and still shows up in period military radio logs and old movies.',
      },
      {
        q: "Why does Charlie spell C in more than one alphabet?",
        a: "Charlie has been reused across several spelling alphabets, including both the NATO standard and the older US Army legacy alphabet, because it is unambiguous to pronounce and recognize over noisy radio in most languages, so several separate alphabets kept it rather than replacing it.",
      },
    ],
  },
};
