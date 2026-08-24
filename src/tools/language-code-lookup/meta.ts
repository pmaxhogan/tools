import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "language-code-lookup",
  icon: "Type",
  name: "Language Code Lookup",
  description:
    "Look up a language by ISO 639 code, English name, or native name, or a writing script by ISO 15924 code.",
  category: "Text",
  keywords: [
    "language code lookup",
    "iso 639 lookup",
    "iso 639-1 code",
    "iso 639-2 code",
    "iso 639-3 code",
    "iso 15924 script lookup",
  ],
  searchTerms: [
    "two letter language code",
    "three letter language code",
    "what language code is this",
    "language native name",
    "writing system lookup",
    "script code lookup",
    "text direction lookup",
    "right to left languages",
    "language family lookup",
    "number of speakers by language",
    "bcp 47 subtag lookup",
    "locale code lookup",
  ],
  input: "text/plain",
  output: "application/json",
  examples: [
    { label: "By ISO code", input: "ja" },
    { label: "By name", input: "Swahili" },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: 'Searches 8,265 languages by ISO 639-1, 639-2, or 639-3 code, English name, or native name, and shows every ISO code on file, writing scripts with their ISO 15924 codes, text direction, speaker count, and language family. The same box also matches a writing script directly by its code or name, such as "Cyrl" or "Cyrillic", and returns the script\'s own record.',
    how: 'Type a code like "ja", a name like "Swahili", or a script name or code like "Cyrillic" or "Cyrl". The best match opens right away. When a query fits several entries equally well, such as two unrelated languages that happen to share an English name, you get the candidates so you can pick one.',
    why: "Looking up an ISO 639 code usually means scrolling a long reference table on a standards body site. This is a plain search that answers in one query, works offline after the first visit, and never sends what you typed anywhere.",
    faq: [
      {
        q: "Where does the data come from?",
        a: "Wikidata, released under CC0 1.0. This is a dated snapshot rebuilt on 2026-08-23, not a live feed, and that date is shown at the bottom of every result.",
      },
      {
        q: "Why does one language show no writing scripts?",
        a: 'An empty scripts list means Wikidata has not recorded an ISO 15924 script for that language, not that the language is unwritten. French is a common example: Wikidata connects it to "French alphabet" rather than to the Latin script, so nothing shows here even though French is obviously written in Latin script.',
      },
      {
        q: "Why did searching a name give me a choice instead of one answer?",
        a: 'A handful of unrelated ISO 639-3 languages share an English name, "Bemba" among them, so a name search can be genuinely ambiguous. Search by ISO code instead when you know it, since codes are unique.',
      },
    ],
  },
};
