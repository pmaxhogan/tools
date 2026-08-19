import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "image-to-ascii",
  matrixSlug: "ascii-art",
  icon: "Type",
  name: "Image to ASCII Art",
  description: "Convert any image into ASCII text art, colored ANSI art, or Unicode braille dot art.",
  category: "Images",
  keywords: [
    "image to ascii art",
    "ascii art generator",
    "convert photo to ascii",
    "ansi art generator",
    "image to text art",
    "ascii art from picture online",
  ],
  searchTerms: [
    "ascii",
    "ansi",
    "braille art",
    "unicode dot art",
    "terminal art",
    "text art generator",
    "picture to text",
    "photo to text art",
    "colored ascii art",
    "html ascii art",
  ],
  input: "image/*",
  output: "text/plain",
  options: [
    {
      kind: "select",
      id: "style",
      label: "Style",
      default: "ascii",
      options: [
        {
          value: "ascii",
          label: "ASCII / ANSI characters",
          synonyms: ["ascii", "ansi", "text", "characters", "letters"],
        },
        {
          value: "braille",
          label: "Braille dots",
          synonyms: ["braille", "unicode dots", "dot matrix", "high resolution", "high res"],
        },
      ],
    },
    {
      kind: "number",
      id: "columns",
      label: "Columns",
      default: 80,
      min: 20,
      max: 200,
      step: 1,
    },
    {
      kind: "select",
      id: "charset",
      label: "Charset (ASCII style)",
      default: "standard",
      options: [
        {
          value: "standard",
          label: "Standard ( .:-=+*#%@)",
          synonyms: ["standard", "default", "classic", "10 level"],
        },
        {
          value: "blocks",
          label: "Blocks ( ░▒▓█)",
          synonyms: ["blocks", "shade blocks", "unicode blocks", "solid"],
        },
        {
          value: "simple",
          label: "Simple ( .oO@)",
          synonyms: ["simple", "minimal", "short", "4 level"],
        },
        {
          value: "custom",
          label: "Custom ramp",
          synonyms: ["custom", "own characters", "user defined", "manual"],
        },
      ],
    },
    {
      kind: "text",
      id: "customChars",
      label: "Custom ramp (least to most dense)",
      default: "",
      placeholder: " .:-=+*#%@",
    },
    {
      kind: "select",
      id: "color",
      label: "Color (ASCII style)",
      default: "none",
      options: [
        {
          value: "none",
          label: "None (plain text)",
          synonyms: ["none", "plain", "monochrome", "no color", "black and white"],
        },
        {
          value: "ansi16",
          label: "ANSI, 16 colors",
          synonyms: ["ansi16", "16 color", "terminal colors", "basic ansi"],
        },
        {
          value: "ansi256",
          label: "ANSI, 256 colors",
          synonyms: ["ansi256", "256 color", "xterm 256", "extended ansi"],
        },
        {
          value: "truecolor",
          label: "Truecolor (24 bit ANSI)",
          synonyms: ["truecolor", "24 bit", "full color ansi", "rgb ansi"],
        },
        {
          value: "html",
          label: "HTML (colored spans)",
          synonyms: ["html", "web", "colored html", "span", "pre"],
        },
      ],
    },
    {
      kind: "boolean",
      id: "invert",
      label: "Invert (for a light background)",
      default: false,
    },
    {
      kind: "number",
      id: "aspect",
      label: "Character aspect ratio (height over width)",
      default: 0.5,
      min: 0.2,
      max: 1,
      step: 0.05,
    },
    {
      kind: "number",
      id: "threshold",
      label: "Dot threshold (braille style)",
      default: 128,
      min: 0,
      max: 255,
      step: 1,
    },
    {
      kind: "boolean",
      id: "brailleDither",
      label: "Dither before thresholding (braille style)",
      default: false,
    },
  ],
  copy: {
    what: "Turns any photo or picture into text art. The ASCII style maps each character cell to one of the built in ramps (a 10 level standard ramp, block shades, a short 4 character ramp, or your own custom ramp) and can color the result with 16 color, 256 color, or 24 bit truecolor ANSI escape codes, or as an HTML block with colored spans. The braille style packs a 2 by 4 grid of dots into a single Unicode braille character, which reproduces roughly 8 times the detail of ASCII in the same number of terminal columns, with an optional Floyd Steinberg dither for smoother gradients.",
    how: "Drop or pick an image, choose ASCII or braille, and set the column count. For ASCII, pick a charset and a color mode, and turn on invert if you are pasting the result onto a light background. For braille, adjust the dot threshold and turn on dithering if flat areas look too blocky. Copy the plain text, copy the raw ANSI escape codes for a terminal, or copy the HTML block, then download whichever version you need.",
    why: "Most ASCII art converters give you one fixed character ramp, no braille mode, and no way to get colored ANSI output for a real terminal, so you end up piecing the result together by hand. This one runs entirely in your browser, so your files and inputs never leave your device, and it covers ASCII, ANSI in three color depths, HTML, and braille in a single tool with no size limit, no watermark, and no account.",
    faq: [
      {
        q: "What is the difference between the ASCII style and the braille style?",
        a: "ASCII maps each character cell to a single brightness level from a ramp like \" .:-=+*#%@\", so one character represents one image cell. Braille packs a 2 by 4 grid of dots into a single Unicode character, so it can show roughly 8 times as much detail in the same number of columns, at the cost of losing the smooth gray levels a character ramp gives you. Use ASCII for a classic look with optional color, and braille for high resolution line art or when you need to fit detail into a narrow terminal or chat window.",
      },
      {
        q: "How do I get colored ANSI art I can paste into a terminal?",
        a: "Set the style to ASCII and pick ANSI 16 colors, ANSI 256 colors, or truecolor from the color option, then copy the result. The output is plain text containing real ANSI escape codes (\\x1b[...m), so pasting it into a terminal, a script, or a tool like cat will show colored characters. Truecolor looks the most accurate but only renders correctly in terminals that support 24 bit color; ANSI 256 is the safest choice for older terminals.",
      },
      {
        q: "Why does my ASCII art look inverted, with dark areas showing as blank space?",
        a: "By default, brighter pixels map to denser characters, which reads correctly against a terminal's usual dark background: a bright subject gets more visible ink. If you are pasting the result onto a white page or a light mode website instead, turn on the invert option, which flips the mapping so dark pixels get the denser characters and light backgrounds stay mostly blank space.",
      },
    ],
  },
};
