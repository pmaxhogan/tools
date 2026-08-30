import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "fancy-text-generator",
  icon: "Sparkles",
  name: "Fancy Text Generator",
  description:
    "Turn plain text into bold, italic, script, fraktur, double-struck, circled, upside down, zalgo, and a dozen other Unicode text styles at once.",
  category: "Text",
  keywords: [
    "fancy text generator",
    "unicode text generator",
    "bold text generator",
    "cursive text generator",
    "zalgo text generator",
    "upside down text generator",
    "cool font generator",
    "instagram bio font",
  ],
  searchTerms: [
    "unicode font converter",
    "aesthetic text generator",
    "small caps generator",
    "double struck text",
    "blackletter text generator",
    "gothic text generator",
    "circled letters generator",
    "squared letters generator",
    "bubble letters generator",
    "fullwidth text generator",
    "monospace text generator",
    "glitch text generator",
    "creepy text generator",
    "sans serif unicode text",
    "copy paste fonts",
    "discord fancy text",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "slider",
      id: "zalgoIntensity",
      label: "Zalgo intensity",
      default: 40,
      min: 0,
      max: 100,
      step: 5,
    },
  ],
  examples: [{ label: "Short greeting", input: "Hello World" }],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Converts plain text into twenty Unicode lookalike styles at once: bold, italic, bold italic, script, fraktur, double-struck, monospace, four sans-serif variants, circled, squared, fullwidth, small caps, upside down, strikethrough, underline, bubble letters, and glitchy zalgo text with an adjustable intensity slider. Every style is a real Unicode character substitution, not an image or a custom font, so the text pastes as text anywhere.",
    how: "Type or paste any text. Every style updates instantly below, each with its own copy button, so you can grab exactly the one you want for a bio, a username, a chat message, or a social post. Drag the zalgo intensity slider to control how many combining marks pile onto each letter.",
    why: "Most fancy text sites cover a handful of styles, bury the page in ads, or need a click before you can copy anything. This one generates all twenty styles in one pass, runs entirely in your browser, and never sends what you type anywhere: your files and inputs never leave your device.",
    faq: [
      {
        q: "Why does this text look broken or show boxes in some apps?",
        a: "These styles are real Unicode code points from the Mathematical Alphanumeric Symbols and Enclosed Alphanumerics blocks, not a font change, so they render only where the app and its fonts support those code points. Most modern browsers, chat apps, and social platforms handle them fine; older apps and some notification previews may show tofu boxes instead.",
      },
      {
        q: "Will this fancy text be read correctly by a screen reader?",
        a: "Not reliably. Screen readers pronounce these as their literal Unicode character names or symbols rather than the letters they visually resemble, so bold or script text can come out as garbled or silent. Avoid these styles for anything that needs to stay accessible, like real body copy or button labels.",
      },
      {
        q: "Why do some letters look different from the rest in script, fraktur, or double-struck?",
        a: "Unicode never assigned code points for every letter in those blocks. Script capital H, fraktur capital C, and double-struck capital N (among a few others) fall back to pre-existing legacy math symbols instead, like ℍ for the set of real numbers, so a handful of letters render in a visually distinct style from their neighbors.",
      },
    ],
  },
};
