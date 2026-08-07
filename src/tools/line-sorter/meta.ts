import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "line-sorter",
  icon: "ArrowDownAZ",
  matrixSlug: "lines",
  name: "Line Tools",
  description: "Sort, deduplicate, reverse and shuffle lines of text.",
  category: "Text",
  keywords: [
    "line sorter",
    "sort lines",
    "dedupe lines",
    "remove duplicate lines",
    "shuffle lines",
    "reverse lines",
    "natural sort",
    "alphabetize text",
  ],
  searchTerms: [
    "sort text lines",
    "unique lines",
    "remove blank lines",
    "randomize list order",
    "text list sorter",
    "sort by length",
    "de-duplicate list",
    "shuffle a list online",
  ],
  input: "text/plain",
  output: "text/plain",
  options: [
    {
      kind: "select",
      id: "operation",
      label: "Operation",
      default: "sort-az",
      choices: [
        { value: "sort-az", label: "Sort A → Z" },
        { value: "sort-za", label: "Sort Z → A" },
        { value: "sort-natural", label: "Sort naturally (item2 before item10)" },
        { value: "sort-length", label: "Sort by length" },
        { value: "dedupe", label: "Deduplicate (keep first)" },
        { value: "reverse", label: "Reverse order" },
        { value: "shuffle", label: "Shuffle" },
      ],
    },
    { kind: "boolean", id: "caseInsensitive", label: "Case-insensitive", default: false },
    { kind: "boolean", id: "trim", label: "Trim each line", default: false },
    { kind: "boolean", id: "removeEmpty", label: "Remove empty lines", default: false },
    {
      kind: "text",
      id: "seed",
      label: "Shuffle seed (optional)",
      default: "",
      placeholder: "Leave blank for random",
    },
  ],
  http: { method: "POST", contentType: "text/plain" },
  copy: {
    what: "Sorts, deduplicates, reverses, or shuffles the lines of any text. Sorting supports plain A-Z/Z-A order, natural order (so item2 comes before item10), and sort-by-length. Deduplication keeps the first occurrence of each line and preserves original order and casing.",
    how: "Paste your text, pick an operation, and toggle case-insensitive, trim, or remove-empty-lines as needed. For shuffle, optionally set a seed to get the same shuffled order every time: leave it blank for a fresh random order on each run.",
    why: "Most line-sorting sites bury this behind ads or only offer plain alphabetical sort. This one runs entirely in your browser, adds natural sort and seeded shuffling that other tools skip, and never sends your text anywhere.",
    faq: [
      {
        q: "What is natural sort and why does it matter?",
        a: 'Natural sort treats embedded numbers as numbers, not characters, so "item2" sorts before "item10" instead of after it, the opposite of what plain alphabetical sort produces.',
      },
      {
        q: "Does deduplicate care about uppercase and lowercase?",
        a: 'Only if you enable case-insensitive. With it on, "Apple" and "apple" count as duplicates and only the first one you typed is kept, in its original casing.',
      },
      {
        q: "Can I get the same shuffle result twice?",
        a: "Yes, enter a seed value and the shuffle becomes deterministic for that seed. The same text and seed always produce the same order; different seeds produce different orders.",
      },
    ],
  },
};
