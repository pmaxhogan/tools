import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "font-subsetter",
  matrixSlug: "subset",
  icon: "FileType",
  name: "Font Subsetter",
  description:
    "Strip a font down to the characters you use and write it back out as WOFF2, WOFF, or OpenType.",
  category: "Docs",
  keywords: [
    "font subsetter online",
    "subset font woff2",
    "reduce font file size",
    "glyphhanger alternative",
    "ttf to woff2 subset",
    "unicode range font subset",
    "web font optimizer",
  ],
  searchTerms: [
    "pyftsubset",
    "fonttools subset",
    "glyphhanger",
    "shrink font file",
    "ttf to woff2",
    "otf to woff2",
    "woff2 converter",
    "font face generator",
    "unicode-range css",
    "strip glyphs from font",
    "webfont diet",
    "font compressor",
  ],
  input: "File",
  output: "application/json",
  options: [
    {
      kind: "text",
      id: "text",
      label: "Characters to keep",
      default: "",
      placeholder: "Paste the exact text this font has to render",
    },
    {
      kind: "select",
      id: "preset",
      label: "Character set",
      default: "basic-latin",
      options: [
        {
          value: "basic-latin",
          label: "Basic Latin",
          synonyms: ["ascii", "english", "u+0020-007e", "latin", "default"],
        },
        {
          value: "latin-1",
          label: "Latin plus Latin-1",
          synonyms: [
            "latin1",
            "western european",
            "accents",
            "iso-8859-1",
            "french",
            "german",
            "spanish",
          ],
        },
        {
          value: "latin-ext",
          label: "Latin extended",
          synonyms: [
            "latin ext",
            "central european",
            "polish",
            "czech",
            "turkish",
            "vietnamese",
            "u+0100-024f",
          ],
        },
        {
          value: "greek",
          label: "Greek plus basic Latin",
          synonyms: ["greek", "hellenic", "u+0370-03ff", "alpha beta"],
        },
        {
          value: "cyrillic",
          label: "Cyrillic plus basic Latin",
          synonyms: ["cyrillic", "russian", "ukrainian", "serbian", "u+0400-04ff"],
        },
        {
          value: "none",
          label: "None, use only my characters",
          synonyms: ["empty", "custom", "manual", "just my text", "nothing"],
        },
      ],
    },
    {
      kind: "text",
      id: "ranges",
      label: "Extra unicode ranges",
      default: "",
      placeholder: "U+2018-201F, U+20AC",
    },
    {
      kind: "select",
      id: "format",
      label: "Output format",
      default: "woff2",
      options: [
        {
          value: "woff2",
          label: "WOFF2",
          synonyms: ["woff2", "brotli", "web font", "smallest", "modern"],
        },
        {
          value: "woff",
          label: "WOFF",
          synonyms: ["woff", "woff1", "zlib", "legacy web font", "old browsers"],
        },
        {
          value: "ttf",
          label: "Uncompressed OpenType (.otf)",
          synonyms: ["otf", "ttf", "sfnt", "raw", "uncompressed", "desktop font"],
        },
      ],
    },
    {
      kind: "boolean",
      id: "includeDigitsPunct",
      label: "Add digits and punctuation",
      default: true,
    },
  ],
  copy: {
    what: 'Rebuilds a font from only the characters you name, then writes it as WOFF2, WOFF, or an uncompressed OpenType file. It reads .ttf, .otf, .woff, and .woff2 input, reports the family name, glyph count, units per em, sfnt tables, and which unicode blocks the font covers, then keeps the glyphs your text and presets ask for and drops the rest. You also get the compressed "unicode-range" list and a ready to paste @font-face rule for the subset. Characters the font has no glyph for are listed by code point instead of silently vanishing.',
    how: "Drop a font file on the panel, then say what to keep: paste the exact text in the characters field, pick a preset like Basic Latin or Cyrillic, or give unicode ranges such as U+2018-201F. Digits and common punctuation are added by default. Choose WOFF2 for the web, WOFF for very old browsers, or the uncompressed OpenType file for a desktop install, and copy the @font-face rule straight into your stylesheet.",
    why: "The usual routes are a Python install for pyftsubset or fonttools, a Node install for glyphhanger, or a font site that wants an account before it will hand back a web font. This one runs the parser and the WOFF2 encoder in the page, so your files and inputs never leave your device, which matters because a licensed font is not something to hand a stranger's server. There are no file size caps, no watermarks, and no upsell over the download button.",
    faq: [
      {
        q: "Which OpenType features are lost?",
        a: "GSUB, GPOS, GDEF, and the legacy kern table are not carried over, so ligatures, contextual alternates, small caps, and kerning pairs from the original are dropped. The subset is rebuilt from glyph outlines rather than edited in place, which is why. The output names the layout tables it discarded, so you know before you ship. For body text and UI text the difference is usually invisible, but a script face or a font that relies on ligatures will look wrong, and those are better subset with pyftsubset. Outlines are also re-emitted as CFF, so a .ttf input comes back as an .otf inside the WOFF2 or WOFF wrapper.",
      },
      {
        q: "How much smaller will my font get?",
        a: "It depends entirely on how much of the font you throw away. A large Latin family cut down to the 95 printable ASCII characters usually loses most of its weight, because the accented Latin, Greek, Cyrillic, and symbol glyphs are the bulk of the file. A font that already covers only basic Latin will barely shrink. Going the other way, a WOFF2 file rebuilt as an uncompressed OpenType file gets bigger, and the output row says so rather than reporting a fake saving.",
      },
      {
        q: "Is my font uploaded anywhere?",
        a: "No. The font is parsed, subset, and compressed inside your browser, so your files and inputs never leave your device. That is the point for a commercially licensed font, where a license usually forbids handing the file to a third party service. The page keeps working with the network switched off after the first load.",
      },
    ],
  },
};
