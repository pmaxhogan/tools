import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "morse-code-translator",
  icon: "Radio",
  name: "Morse Code Translator",
  description:
    "Translate text to and from Morse code automatically, with a timing table for any words-per-minute speed and support for common prosigns.",
  category: "Text",
  keywords: [
    "morse code translator",
    "text to morse code",
    "morse code to text",
    "morse code converter",
    "morse code alphabet",
    "sos morse code",
    "morse code decoder",
    "morse code generator",
  ],
  searchTerms: [
    "dots and dashes translator",
    "telegraph code",
    "international morse code",
    "morse code timing",
    "words per minute morse",
    "morse code prosigns",
    "amateur radio morse code",
    "ham radio code",
    "cw code translator",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "separator",
      label: "Word separator",
      default: "space",
      ui: "segmented",
      options: [
        { value: "space", label: "Extra spaces", synonyms: ["gap", "triple space"] },
        { value: "slash-words", label: "Slash ( / )", synonyms: ["forward slash", "pipe"] },
      ],
    },
    {
      kind: "select",
      id: "dotChar",
      label: "Symbol style",
      default: "dot-dash",
      ui: "segmented",
      options: [
        { value: "dot-dash", label: "Dot / dash ( . - )", synonyms: ["symbols", "dots dashes"] },
        {
          value: "dit-dah-letters",
          label: "Dit / dah words",
          synonyms: ["spoken", "phonetic morse"],
        },
      ],
    },
    {
      kind: "number",
      id: "wpm",
      label: "Speed (words per minute)",
      default: 20,
      min: 5,
      max: 60,
      step: 1,
    },
  ],
  examples: [
    { label: "Encode SOS", input: "SOS" },
    { label: "Decode a message", input: "... --- ...", opts: { separator: "space" } },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Translates between plain text and International Morse code in either direction, auto-detecting which way to go from what you paste in. It covers the full letter, digit, and punctuation set plus common procedural prosigns like <AR> (end of message) and <SOS>, and it reports the exact PARIS-standard timing (dit, dah, and every gap length in milliseconds) for the words-per-minute speed you choose.",
    how: "Paste text to get its Morse code, or paste dots and dashes to get text back: the tool detects the direction automatically. Choose whether word breaks render as extra spaces or a slash, and whether symbols show as dots and dashes or spoken dit/dah words. The timing table below the output shows what that message sounds like at your chosen speed.",
    why: "Most Morse translators online only go one direction, get a prosign or punctuation mark wrong, or skip timing entirely. This one is bidirectional, includes prosigns and the full punctuation set, and shows real PARIS-standard timing math for any speed, all client-side with no ads: your files and inputs never leave your device.",
    faq: [
      {
        q: "How does the tool know whether I typed text or Morse code?",
        a: "It checks whether the input contains only dots, dashes, slashes, and whitespace. If so, it treats it as Morse and decodes to text; otherwise it treats it as text and encodes to Morse.",
      },
      {
        q: "What is the PARIS standard for words per minute?",
        a: 'Morse speed is measured by how long it takes to send the word "PARIS" (including its trailing word gap) repeatedly at a given rate. One dit lasts 1200 divided by the WPM figure in milliseconds; a dah is three dits, the gap between letters is three dits, and the gap between words is seven dits.',
      },
      {
        q: "What are prosigns like <AR> and <SOS>?",
        a: "Prosigns are procedural signals sent as a single unbroken run of dots and dashes with no gap between the letters that make them up, used for things like ending a message (<AR>) or requesting a specific station respond (<KN>). Type one as its bracketed name, like <AR>, and it encodes as one continuous symbol run.",
      },
    ],
  },
};
