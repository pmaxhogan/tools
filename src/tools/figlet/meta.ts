import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "figlet",
  icon: "Type",
  matrixSlug: "figlet",
  name: "Figlet ASCII Banner",
  description: "Render text as ASCII banner art in a choice of classic FIGlet fonts.",
  category: "Text",
  keywords: [
    "figlet",
    "ascii art generator",
    "ascii banner",
    "text to ascii art",
    "ascii text generator",
    "banner text",
    "ascii art font",
  ],
  searchTerms: [
    "figlet fonts",
    "text banner generator",
    "ascii art text",
    "big text generator",
    "terminal banner",
    "readme banner",
    "cli splash screen",
    "motd generator",
    "block letters text",
    "text art maker",
  ],
  input: "text/plain",
  output: "text/plain",
  options: [
    {
      kind: "select",
      id: "font",
      label: "Font",
      default: "Standard",
      groups: [
        {
          label: "Classic",
          synonyms: ["default fonts", "plain block letters", "simple", "readable"],
          options: [
            {
              value: "Standard",
              label: "Standard",
              synonyms: ["default font", "classic figlet", "original"],
            },
            {
              value: "Small",
              label: "Small",
              synonyms: ["compact", "small text", "narrow"],
            },
            {
              value: "Mini",
              label: "Mini",
              synonyms: ["tiny", "smallest", "one line"],
            },
          ],
        },
        {
          label: "Slanted and shadow",
          synonyms: ["italic style", "3d shadow", "angled", "leaning"],
          options: [
            {
              value: "Slant",
              label: "Slant",
              synonyms: ["italic", "slanted", "leaning letters"],
            },
            {
              value: "Shadow",
              label: "Shadow",
              synonyms: ["drop shadow", "3d effect", "shadowed letters"],
            },
          ],
        },
        {
          label: "Bold and block",
          synonyms: ["heavy", "thick letters", "large banner", "wide"],
          options: [
            {
              value: "Big",
              label: "Big",
              synonyms: ["large", "big text", "bold"],
            },
            {
              value: "Block",
              label: "Block",
              synonyms: ["blocky", "solid letters", "chunky"],
            },
            {
              value: "Banner",
              label: "Banner",
              synonyms: ["wide banner", "billboard style", "big banner"],
            },
          ],
        },
        {
          label: "Decorative",
          synonyms: ["stylized", "outline font", "gothic", "spooky"],
          options: [
            {
              value: "Doom",
              label: "Doom",
              synonyms: ["horror style", "video game font", "gothic"],
            },
            {
              value: "Ghost",
              label: "Ghost",
              synonyms: ["outline font", "spooky", "faded"],
            },
          ],
        },
      ],
    },
    {
      kind: "select",
      id: "layout",
      label: "Letter spacing",
      default: "default",
      options: [
        {
          value: "default",
          label: "Default: the font's own kerning",
          synonyms: ["normal spacing", "font default", "original kerning"],
        },
        {
          value: "full",
          label: "Full: no letters touching",
          synonyms: ["wide spacing", "spaced out", "no overlap"],
        },
        {
          value: "fitted",
          label: "Fitted: letters pushed together",
          synonyms: ["tight spacing", "compact", "kerned tight"],
        },
      ],
    },
    {
      kind: "slider",
      id: "maxWidth",
      label: "Maximum width (0 = unlimited, scrolls instead of wrapping)",
      default: 0,
      min: 0,
      max: 300,
      step: 10,
    },
  ],
  http: { method: "GET", contentType: "text/plain" },
  copy: {
    what: "Turns a word or short phrase into a large ASCII-art banner using the FIGlet font format. Ten classic fonts are included (Standard, Slant, Small, Big, Banner, Block, Shadow, Doom, Ghost and Mini) covering everything from compact one-liners to heavy 3D-style lettering. A letter-spacing control switches between the font's own kerning, fully separated letters, and tightly fitted ones.",
    how: "Type your text into the input, pick a font, and the banner renders as you type. Adjust letter spacing if the letters look too cramped or too loose, then copy the result straight into a README, a CLI splash screen, a terminal MOTD, or a code comment. Maximum width stays at 0 (unlimited) by default, so a long banner renders as one continuous strip that scrolls sideways instead of breaking; set a width in columns to have it wrap onto a new banner block, always between whole letters. Keep the text itself under 100 characters: banner fonts are several lines tall, so anything longer stops being readable.",
    why: 'Most ASCII-art generators wrap a handful of fonts in ad banners, newsletter popups and a "download as image" upsell. This one renders locally in your browser, so your text never leaves your device, there are no rate limits, and the output is plain monospaced text you can copy in one click.',
    faq: [
      {
        q: "What is FIGlet?",
        a: "FIGlet is a long-standing Unix program that draws text in large letters made of ordinary characters. Its .flf font format is what this tool renders, so the output matches what the figlet command-line tool would print.",
      },
      {
        q: "Why does my banner look broken when I paste it somewhere?",
        a: "ASCII banners only line up in a monospaced font. Paste into a code block, a terminal, or a fenced README block rather than a proportional-font document.",
      },
      {
        q: "Can I use the banners commercially?",
        a: "Yes. The output is plain text you generated, and the FIGlet fonts included here ship under permissive terms: they are commonly used in open-source README files and CLI tools.",
      },
    ],
  },
};
