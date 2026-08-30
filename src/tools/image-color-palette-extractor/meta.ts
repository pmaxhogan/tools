import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "image-color-palette-extractor",
  icon: "Palette",
  name: "Image Color Palette Extractor",
  description:
    "Pull the dominant colors out of an image as hex, rgb, hsl and oklch swatches with ready made CSS.",
  category: "Color",
  keywords: [
    "image color palette extractor",
    "get colors from image",
    "dominant color from photo",
    "color palette generator from image",
    "hex codes from picture",
    "extract brand colors",
    "css palette from image",
    "photo color scheme",
  ],
  searchTerms: [
    "colour palette from image",
    "median cut quantization",
    "k means color clustering",
    "eyedropper whole image",
    "average color of photo",
    "tailwind palette from screenshot",
    "swatches from artwork",
    "what colors are in this image",
  ],
  input: "image/*",
  output: "application/json",
  options: [
    {
      kind: "number",
      id: "colors",
      label: "Colors",
      default: 6,
      min: 2,
      max: 16,
      step: 1,
    },
    {
      kind: "select",
      id: "sort",
      label: "Order",
      default: "share",
      options: [
        {
          value: "share",
          label: "Most used first",
          synonyms: ["share", "dominant", "frequency", "count", "popularity"],
        },
        {
          value: "lightness",
          label: "Lightest first",
          synonyms: ["lightness", "brightness", "luminance", "light to dark"],
        },
        {
          value: "hue",
          label: "By hue",
          synonyms: ["hue", "rainbow", "spectrum", "color wheel"],
        },
      ],
    },
    {
      kind: "boolean",
      id: "ignoreTransparent",
      label: "Skip transparent pixels",
      default: true,
    },
    {
      kind: "text",
      id: "cssPrefix",
      label: "CSS name prefix",
      default: "color",
      placeholder: "brand",
    },
  ],
  examples: [{ label: "Sample landscape photo", file: "sample-photo.jpg" }],
  copy: {
    what: "Reduces a picture to the two to sixteen colors it is really made of, and gives each one back as hex, rgb(), hsl() and oklch() with the share of the image it covers. The clustering runs median cut first to split the colors the picture actually contains, then a dozen rounds of k-means to move each center to the middle of its cluster, both in OKLab so distance means what your eye means by it. Every swatch also carries a black or white label color chosen by WCAG contrast, and the whole palette comes out as CSS custom properties, a Tailwind theme block, JSON, or a PNG strip.",
    how: "Drop an image, paste one from the clipboard, or pick a file. Set how many colors you want with the slider and the palette updates immediately. Switch the order to sort by lightness or around the hue wheel when you are building a scale rather than reporting the most used colors. Each swatch has its own copy button for the hex, and the export block below has one copy button per format. The color count and the ordering live in the URL, so a shared link opens the same settings.",
    why: "Most palette extractors upload your image, cap you at five colors, or hand back a picture of the swatches with no text you can copy. This one runs the clustering in your browser, so your files and inputs never leave your device, gives you the code you were going to write anyway, and tells you what fraction of the picture each color covers, which is the difference between a real dominant color and a stray highlight.",
    faq: [
      {
        q: "Why do I get different colors from other palette tools?",
        a: "Most of them cluster in sRGB, where equal numeric distances are not equal perceptual distances, so shadows collapse into one entry and highlights get several. This one clusters in OKLab, which is built so that a fixed distance looks like a fixed difference. It also seeds with median cut rather than at random, so the answer is the same every time you run it on the same image.",
      },
      {
        q: "Does it look at every pixel?",
        a: "It strides evenly through the image and clusters up to 24,000 pixels. Past that the palette stops moving, and striding rather than cropping means a color that only appears in one corner is still counted. The report tells you how many pixels were sampled out of how many the image holds.",
      },
      {
        q: "What is the label color for?",
        a: "It is the black or white that has the higher WCAG contrast against that swatch, so you can put text on the color without checking each one by hand. The contrast ratio it achieved is reported alongside, because on a mid tone color the better of the two options can still be a poor choice for body text.",
      },
    ],
  },
};
