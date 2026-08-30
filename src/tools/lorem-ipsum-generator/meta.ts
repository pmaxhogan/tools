import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "lorem-ipsum-generator",
  icon: "FileText",
  name: "Lorem Ipsum Generator",
  description:
    "Generate placeholder paragraphs, sentences, or words in classic Latin or plain English filler, as plain text, HTML, or Markdown.",
  category: "Text",
  keywords: [
    "lorem ipsum generator",
    "placeholder text generator",
    "dummy text generator",
    "filler text generator",
    "lorem ipsum paragraphs",
    "sample text generator",
    "fake text generator",
    "greeking text generator",
  ],
  searchTerms: [
    "lorem ipsum dolor sit amet",
    "placeholder paragraph generator",
    "html placeholder text",
    "markdown placeholder text",
    "english lorem ipsum alternative",
    "design mockup text",
    "wireframe filler text",
    "random word generator",
  ],
  input: "none",
  output: "text/plain",
  inputOptional: {
    label: "Seed (optional)",
    hint: "Leave blank for a fresh random result each time, or enter any text to make the output reproducible: sharing the link will regenerate the exact same text.",
  },
  options: [
    {
      kind: "select",
      id: "units",
      label: "Units",
      default: "paragraphs",
      ui: "segmented",
      options: [
        { value: "paragraphs", label: "Paragraphs", synonyms: ["paras"] },
        { value: "sentences", label: "Sentences", synonyms: [] },
        { value: "words", label: "Words", synonyms: [] },
      ],
    },
    { kind: "number", id: "count", label: "Count", default: 5, min: 1, max: 500, step: 1 },
    {
      kind: "select",
      id: "variant",
      label: "Variant",
      default: "classic",
      ui: "segmented",
      options: [
        { value: "classic", label: "Classic Latin", synonyms: ["traditional", "lorem ipsum"] },
        { value: "english", label: "Plain English", synonyms: ["business filler", "no latin"] },
      ],
    },
    {
      kind: "boolean",
      id: "startWithLorem",
      label: 'Start with "Lorem ipsum dolor sit amet"',
      default: true,
    },
    {
      kind: "select",
      id: "format",
      label: "Output format",
      default: "plain",
      ui: "segmented",
      options: [
        { value: "plain", label: "Plain text", synonyms: ["txt"] },
        { value: "html", label: "HTML (<p> tags)", synonyms: ["html paragraphs"] },
        { value: "markdown", label: "Markdown", synonyms: ["md"] },
      ],
    },
  ],
  examples: [
    { label: "Five classic paragraphs", opts: { units: "paragraphs", count: "5" } },
    {
      label: "Reproducible seeded text",
      input: "my-design-mockup",
      opts: { units: "paragraphs", count: "3" },
    },
  ],
  http: { method: "GET", contentType: "text/plain" },
  copy: {
    what: 'Generates placeholder text as paragraphs, sentences, or words, in either the classic Latin Lorem Ipsum word bank or a plain English business-filler alternative for when Latin looks out of place. Output can start with the traditional "Lorem ipsum dolor sit amet" opener, and renders as plain text, HTML wrapped in paragraph tags, or Markdown.',
    how: "Choose units (paragraphs, sentences, or words) and a count, pick a variant and output format, and the text generates instantly. Leave the optional seed field blank for a fresh random result every time, or type anything into it to make the output reproducible: sharing the link regenerates the exact same text for anyone who opens it.",
    why: "Most lorem ipsum generators only do Latin, only output plain text, and give you a different result every time you reload, which breaks a shared link. This one adds a plain English variant, HTML and Markdown output, and an optional seed for reproducible results, all client-side with no ads: your files and inputs never leave your device.",
    faq: [
      {
        q: "How does the optional seed make the output reproducible?",
        a: "Typing text into the seed field feeds a deterministic pseudo-random generator, so the exact same seed with the exact same options always produces the exact same placeholder text. That means a shared link with a seed in it regenerates identically for everyone who opens it, unlike most generators that reroll randomly on every page load.",
      },
      {
        q: "Why offer a plain English variant instead of only Latin?",
        a: "Classic Lorem Ipsum reads as obvious gibberish to Latin speakers and can look unfinished in a client-facing mockup. The plain English variant uses generic business and product words instead of Latin, so a design review reads as plausible sample copy rather than an obviously fake placeholder.",
      },
      {
        q: "What is the difference between the Markdown and plain text formats here?",
        a: "For pure prose paragraphs they are the same output: Markdown already treats blank-line separated paragraphs as its paragraph syntax, so there is no extra markup to add. The HTML format is the one that actually differs, wrapping each paragraph in its own <p> tag.",
      },
    ],
  },
};
