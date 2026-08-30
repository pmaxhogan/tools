import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "meme-generator",
  icon: "Captions",
  name: "Meme Generator",
  description:
    "Add classic caption text to any image and export it as a PNG, with no account and no watermark.",
  category: "Images",
  keywords: [
    "meme generator",
    "meme maker",
    "impact font meme text",
    "add text to image",
    "caption an image",
    "top and bottom text meme",
    "meme maker no watermark",
    "white caption bar meme",
  ],
  searchTerms: [
    "make a meme from my own photo",
    "meme text generator",
    "add white bar above image",
    "outline text on picture",
    "instagram caption image",
    "no signup meme maker",
    "blank meme template",
  ],
  input: "image/*",
  output: "application/json",
  inputOptional: {
    label: "Quick entry",
    hint: 'The text surface only needs the picture size, written as "1080x1080".',
  },
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Layout",
      default: "classic",
      options: [
        {
          value: "classic",
          label: "Classic top and bottom",
          synonyms: ["impact", "classic", "over the image", "top bottom", "old school"],
        },
        {
          value: "caption",
          label: "Caption bar above",
          synonyms: ["caption", "white bar", "tumblr", "above", "header"],
        },
      ],
    },
    {
      kind: "text",
      id: "topText",
      label: "Top text",
      default: "",
      placeholder: "One does not simply",
    },
    {
      kind: "text",
      id: "bottomText",
      label: "Bottom text",
      default: "",
      placeholder: "Ship on a Friday",
    },
    {
      kind: "text",
      id: "captionText",
      label: "Caption",
      default: "",
      placeholder: "when the tests finally pass",
    },
    {
      kind: "slider",
      id: "fontPercent",
      label: "Text size",
      default: 11,
      min: 2,
      max: 30,
      step: 0.5,
    },
    { kind: "text", id: "color", label: "Text color", default: "#ffffff", placeholder: "#ffffff" },
    {
      kind: "text",
      id: "outline",
      label: "Outline color",
      default: "#000000",
      placeholder: "#000000",
    },
    {
      kind: "slider",
      id: "outlinePercent",
      label: "Outline thickness",
      default: 8,
      min: 0,
      max: 30,
      step: 1,
    },
    { kind: "boolean", id: "uppercase", label: "Shout it in capitals", default: true },
    {
      kind: "select",
      id: "blank",
      label: "Blank canvas",
      default: "none",
      options: [
        {
          value: "none",
          label: "Use my picture",
          synonyms: ["none", "photo", "image", "upload", "off"],
        },
        {
          value: "square",
          label: "Square, 1080 by 1080",
          synonyms: ["square", "instagram", "1:1"],
        },
        {
          value: "portrait",
          label: "Portrait, 1080 by 1350",
          synonyms: ["portrait", "tall", "4:5"],
        },
        {
          value: "landscape",
          label: "Landscape, 1200 by 630",
          synonyms: ["landscape", "wide", "og image", "link preview"],
        },
        {
          value: "story",
          label: "Story, 1080 by 1920",
          synonyms: ["story", "reel", "9:16", "vertical"],
        },
      ],
    },
    {
      kind: "text",
      id: "blankColor",
      label: "Blank canvas color",
      default: "#111111",
      placeholder: "#111111",
    },
  ],
  examples: [{ label: "Sample landscape photo", file: "sample-photo.jpg" }],
  copy: {
    what: "Puts caption text on your own picture and exports it as a PNG. Two layouts: the classic one, with heavy outlined capitals over the top and bottom of the image, and the caption format, which puts a plain bar above the picture so nothing covers it. Text wraps automatically and shrinks to fit rather than running off the edge, either block can be dragged anywhere on the image, and the size, color, outline color and outline thickness are all adjustable. There is also a blank colored canvas in four common aspect ratios for a meme that is only words.",
    how: "Drop an image, paste one from the clipboard, or pick a blank canvas, then type the top and bottom lines. Drag either line to move it, and use the sliders for size and outline. When it looks right, save the PNG or press Copy image to put it straight on the clipboard for pasting into a chat.",
    why: "The big meme sites stamp their own logo on your image, want you to sign in, and rebuild the same three text boxes around a page of ads. This one does the same job with no account, no logo, and no upload: the compositing runs on a canvas in this tab, so your files and inputs never leave your device. It also fits the text properly instead of letting a long line disappear off the side.",
    faq: [
      {
        q: "Why does the text not look exactly like Impact?",
        a: "Impact cannot be redistributed as a webfont, so this uses a font stack instead: Impact where it is installed, which is most Windows and macOS machines, then Anton or Arial Narrow Bold, then the system sans. On a machine with none of those the shape differs slightly, but the layout, wrapping, and outline stay identical because the panel measures whatever face it actually got.",
      },
      {
        q: "Are there built in templates?",
        a: "No, and that is deliberate. The well known template images are other people's photographs, and bundling them would mean redistributing them. Bring your own picture, or start from a blank colored canvas in one of the four preset sizes.",
      },
      {
        q: "Does Copy image work everywhere?",
        a: "It needs the browser's async clipboard with image support, which Chrome, Edge, and Safari have and which Firefox has behind a setting. If the button is not available the panel says so and the Save PNG button does the same job in one extra step.",
      },
    ],
  },
};
