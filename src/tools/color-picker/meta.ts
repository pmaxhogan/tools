import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "color-picker",
  matrixSlug: "color",
  icon: "Palette",
  name: "Colour Suite",
  description:
    "Convert any CSS colour between hex, rgb, hsl, hwb, oklch, oklab, lab and lch, check WCAG contrast, and build palettes in OKLCH.",
  category: "Dev",
  keywords: [
    "color picker",
    "hex to rgb",
    "hsl to hex",
    "oklch converter",
    "contrast checker",
    "color palette generator",
    "css color converter",
  ],
  searchTerms: [
    "colour picker",
    "colour converter",
    "rgb to hex",
    "hex to hsl",
    "oklab converter",
    "lab color converter",
    "wcag contrast ratio",
    "tailwind color scale generator",
    "complementary colors",
    "css named colors list",
    "hwb converter",
    "gamut mapping",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Mode",
      default: "convert",
      options: [
        {
          value: "convert",
          label: "Convert",
          synonyms: ["conversion", "formats", "hex to rgb", "picker", "translate", "all formats"],
        },
        {
          value: "contrast",
          label: "Contrast check",
          synonyms: ["wcag", "accessibility", "a11y", "ratio", "aa", "aaa", "readability"],
        },
        {
          value: "palette",
          label: "Palette",
          synonyms: ["swatches", "scheme", "harmony", "shades", "tints", "scale", "theme"],
        },
      ],
    },
    {
      kind: "select",
      id: "paletteKind",
      label: "Palette to build",
      default: "all",
      groups: [
        {
          label: "Everything",
          synonyms: ["all", "full", "every palette", "complete"],
          options: [
            {
              value: "all",
              label: "All palettes",
              synonyms: ["everything", "full set", "every family"],
            },
          ],
        },
        {
          label: "Hue rotations",
          synonyms: ["harmony", "colour wheel", "color wheel", "schemes", "opposite hues"],
          options: [
            {
              value: "complementary",
              label: "Complementary",
              synonyms: ["opposite", "180 degrees", "contrast pair"],
            },
            {
              value: "analogous",
              label: "Analogous",
              synonyms: ["neighbours", "neighbors", "adjacent", "plus or minus 30 degrees"],
            },
            {
              value: "triadic",
              label: "Triadic",
              synonyms: ["triad", "three way", "120 degrees"],
            },
            {
              value: "tetradic",
              label: "Tetradic",
              synonyms: ["square", "four way", "rectangle", "90 degrees"],
            },
            {
              value: "split",
              label: "Split complementary",
              synonyms: ["split complement", "150 degrees", "210 degrees"],
            },
          ],
        },
        {
          label: "Lightness ramps",
          synonyms: ["shades", "tints", "steps", "ramp", "scale", "design tokens"],
          options: [
            {
              value: "tints",
              label: "Tints (toward white)",
              synonyms: ["lighter", "pastels", "wash", "light steps"],
            },
            {
              value: "shades",
              label: "Shades (toward black)",
              synonyms: ["darker", "deep", "dark steps"],
            },
            {
              value: "scale",
              label: "Numbered scale 50 to 950",
              synonyms: ["tailwind", "design tokens", "50 100 200", "ramp", "theme scale"],
            },
          ],
        },
      ],
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Reads any CSS colour and rewrites it in every syntax: hex, rgb, hsl, hwb, oklch, oklab, lab and lch, plus the nearest of the 148 CSS colour names. It also checks WCAG 2 contrast, either for one colour against white and black or between two colours you supply, and builds palettes in OKLCH: complementary, analogous, triadic, tetradic, split complementary, five tints, five shades, and a numbered scale from 50 to 950. Colours from outside the sRGB gamut are fitted by reducing chroma while lightness and hue hold, and the result tells you when that happened.",
    how: 'Paste a colour such as #663399, rgb(102 51 153), oklch(0.44 0.16 303) or rebeccapurple and the conversion rows appear straight away. Switch the mode to "Contrast check" and write two colours as "#777777 on #ffffff" or "#777777, #ffffff" to get the ratio and the AA and AAA verdicts for normal and large text. Switch to "Palette" and pick a family to generate swatches, each with its hex and its OKLCH. Every row has a copy button, and the URL carries what you see so you can share it.',
    why: "Most colour converters online run one conversion per page, wrap it in ad slots, and stop at hex, rgb and hsl. This one does the modern spaces too, gets the white points right, gamut maps instead of silently clipping, and rotates palette hues in OKLCH so a generated scheme keeps an even perceived lightness. Your inputs never leave your device, and there is no signup or swatch limit.",
    faq: [
      {
        q: "Why are the palettes built in OKLCH instead of HSL?",
        a: "HSL lightness is a rough arithmetic average, so rotating hue at a fixed HSL lightness makes yellows look washed out and blues look heavy. OKLCH lightness tracks what the eye actually sees, so a hue rotation or a tint step keeps its perceived weight. Any rotation that lands outside sRGB has its chroma reduced until it fits, and the row says so.",
      },
      {
        q: "How accurate are the conversions, and which white point do they use?",
        a: "The OKLab and OKLCH numbers use the matrices published by Bjorn Ottosson exactly, so pure red comes out as oklch(0.628 0.2577 29.23). The lab() and lch() values use D50, which is the white point CSS Color 4 defines for those functions, reached from sRGB through XYZ D65 and a Bradford adaptation: red is lab(54.29 80.8 69.89). Under D65 the same red is 53.24, 80.09, 67.20, so a converter that disagrees with this one is usually reporting a different white point. Contrast is WCAG 2 only; APCA Lc is not computed.",
      },
      {
        q: "Is my colour or palette uploaded anywhere?",
        a: "No. Every conversion, contrast check and palette runs in your browser, nothing is logged, and the page keeps working offline after the first load.",
      },
    ],
  },
};
