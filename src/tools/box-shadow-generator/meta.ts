import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "box-shadow-generator",
  icon: "Layers",
  name: "Box Shadow Generator",
  description:
    "Stack multiple CSS box-shadow layers visually, preview them on light and dark, and copy the CSS or the Tailwind value.",
  category: "Dev",
  keywords: [
    "css box shadow generator",
    "layered box shadow",
    "material elevation css",
    "neumorphism generator",
    "inset shadow css",
    "tailwind shadow arbitrary value",
    "box shadow preview",
  ],
  searchTerms: [
    "drop shadow css",
    "elevation shadow",
    "soft ui shadow",
    "focus ring box shadow",
    "shadow spread radius",
    "multiple shadows one element",
    "box-shadow inset",
    "shadow colour picker", // spelling: allow
    "rgba shadow",
    "material design elevation values",
  ],
  input: "text/plain",
  output: "text/plain",
  inputOptional: {
    label: "Paste an existing box-shadow",
    hint: "Paste a value like 0 1px 3px rgba(0, 0, 0, 0.2), inset 0 1px 0 #fff and it is read back into editable layers. Leave it empty to start from a preset.",
  },
  options: [
    {
      kind: "select",
      id: "preset",
      label: "Preset",
      default: "material-2",
      groups: [
        {
          label: "Material elevation",
          synonyms: ["material design", "google", "dp", "elevation", "android"],
          options: [
            {
              value: "material-1",
              label: "Elevation 1",
              synonyms: ["1dp", "subtle", "resting", "lowest"],
            },
            {
              value: "material-2",
              label: "Elevation 2",
              synonyms: ["2dp", "card", "default", "resting card"],
            },
            {
              value: "material-3",
              label: "Elevation 3",
              synonyms: ["3dp", "hover", "raised card"],
            },
            {
              value: "material-4",
              label: "Elevation 4",
              synonyms: ["4dp", "app bar", "raised button"],
            },
            {
              value: "material-5",
              label: "Elevation 5",
              synonyms: ["6dp", "floating action button", "fab", "menu", "highest"],
            },
          ],
        },
        {
          label: "Styles",
          synonyms: ["looks", "aesthetics", "shapes"],
          options: [
            {
              value: "soft",
              label: "Soft ambient",
              synonyms: ["subtle", "diffuse", "modern", "faint", "airy"],
            },
            {
              value: "neumorphic",
              label: "Neumorphic",
              synonyms: ["neumorphism", "soft ui", "embossed", "claymorphism"],
            },
            {
              value: "hard",
              label: "Hard offset",
              synonyms: ["brutalist", "solid", "no blur", "sticker", "retro"],
            },
            {
              value: "inset-well",
              label: "Inset well",
              synonyms: ["carved", "pressed", "sunken", "inner shadow", "inset"],
            },
            {
              value: "focus-ring",
              label: "Focus ring",
              synonyms: ["outline", "glow", "spread only", "accessibility", "keyboard focus"],
            },
          ],
        },
      ],
    },
    {
      kind: "select",
      id: "colorSyntax",
      label: "Color syntax",
      default: "rgba",
      options: [
        {
          value: "rgba",
          label: "rgba(0, 0, 0, 0.2)",
          synonyms: ["legacy", "comma", "classic", "widest support"],
        },
        {
          value: "hex",
          label: "#00000033",
          synonyms: ["hex alpha", "eight digit hex", "short", "compact"],
        },
        {
          value: "modern",
          label: "rgb(0 0 0 / 20%)",
          synonyms: ["space separated", "css color 4", "slash", "percentage alpha"],
        },
      ],
    },
    {
      kind: "select",
      id: "format",
      label: "Output",
      default: "both",
      options: [
        { value: "css", label: "CSS", synonyms: ["stylesheet", "declaration", "plain"] },
        {
          value: "tailwind",
          label: "Tailwind",
          synonyms: ["utility", "arbitrary value", "class", "tw"],
        },
        { value: "both", label: "Both", synonyms: ["everything", "css and tailwind"] },
      ],
    },
    {
      kind: "slider",
      id: "scale",
      label: "Scale every length",
      default: 1,
      min: 0.25,
      max: 4,
      step: 0.05,
    },
  ],
  examples: [
    { label: "Material elevation 2", input: "", opts: { preset: "material-2" } },
    { label: "Soft ambient card", input: "", opts: { preset: "soft" } },
    {
      label: "Read back an existing value",
      input: "0 1px 2px rgba(0, 0, 0, 0.06), 0 8px 24px -4px rgba(0, 0, 0, 0.1)",
    },
  ],
  http: { method: "GET", contentType: "text/plain" },
  copy: {
    what: "Builds a CSS box-shadow out of as many layers as you want, each with its own offsets, blur, spread, color, opacity, and inset flag. Layers can be added, removed, and reordered, which matters because a box-shadow paints the first layer on top. A pasted value is read back into editable layers, so an existing shadow can be adjusted rather than rebuilt, and the preview draws the result on a light card and a dark card side by side.",
    how: "Start from a preset or paste a value you already have, then adjust the sliders for each layer. Use the color field for the hue and the opacity slider for the alpha, since a native color input cannot carry transparency. Copy the CSS declaration or the Tailwind arbitrary value from the buttons under the output, and switch the color syntax if your codebase prefers hex alpha or the modern slash notation.",
    why: "Most shadow generators give you one layer, which is the wrong shape for a good shadow: real depth comes from a tight contact shadow under a wide soft one. This one is built around a layer list, ships the Material elevation values and the neumorphic and hard offset shapes as presets, previews on both themes because a shadow tuned on white usually disappears on dark, and reads an existing value back so you can edit what you already shipped. It runs entirely in the page, so your files and inputs never leave your device.",
    faq: [
      {
        q: "Why does my shadow look wrong on a dark background?",
        a: "A black shadow at low opacity has almost nothing to darken once the surface behind it is already dark, so the element stops reading as raised. The usual fixes are to raise the opacity, to tint the shadow toward the page background rather than pure black, or to swap the shadow for a lighter top border, which is how surfaces are separated in dark themes. The preview here draws the same value on both fields so the difference is visible before you ship it.",
      },
      {
        q: "What does the spread radius actually do?",
        a: "Spread grows or shrinks the shadow shape before the blur is applied, following the border radius as it goes. A positive spread with zero blur draws an even outline, which is how a focus ring is built out of box-shadow. A negative spread pulls the shadow in on all sides, which is the trick behind a shadow that appears to sit under an element rather than around it.",
      },
      {
        q: "Can I use this with Tailwind?",
        a: "Yes. The Tailwind output is an arbitrary value like shadow-[0_1px_2px_rgba(0,0,0,0.1)]. Tailwind class names cannot contain spaces, so every space in the CSS value becomes an underscore, and the layers are joined by plain commas. If you use the shadow in more than one place, paste the CSS value into a theme entry instead and keep the utility for one-offs.",
      },
    ],
  },
};
