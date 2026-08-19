import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "color-blindness-simulator",
  matrixSlug: "colorblind",
  icon: "Eye",
  name: "Colour Blindness Simulator",
  description: "Preview palettes and images under colour vision deficiencies.",
  category: "Dev",
  keywords: [
    "color blindness simulator",
    "colorblind palette checker",
    "deuteranopia simulator",
    "protanopia simulator",
    "tritanopia simulator",
    "accessible color palette",
    "color vision deficiency preview",
  ],
  searchTerms: [
    "colour blindness simulator",
    "daltonism",
    "red green colour blind",
    "cvd simulation",
    "machado matrices",
    "achromatopsia grayscale",
    "wcag contrast palette",
    "is my palette colorblind safe",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "kind",
      label: "Deficiency",
      default: "all",
      groups: [
        {
          label: "Everything",
          synonyms: ["all types", "compare", "every deficiency", "side by side"],
          options: [
            {
              value: "all",
              label: "All seven",
              synonyms: ["all", "every type", "compare all", "full report"],
            },
          ],
        },
        {
          label: "Red and green deficiency",
          synonyms: ["red green colour blind", "red green color blind", "daltonism", "most common"],
          options: [
            {
              value: "protanopia",
              label: "Protanopia",
              synonyms: ["red blind", "no red", "protan", "missing L cone"],
            },
            {
              value: "protanomaly",
              label: "Protanomaly",
              synonyms: ["weak red", "red weak", "protan mild", "partial red"],
            },
            {
              value: "deuteranopia",
              label: "Deuteranopia",
              synonyms: ["green blind", "no green", "deutan", "missing M cone"],
            },
            {
              value: "deuteranomaly",
              label: "Deuteranomaly",
              synonyms: ["weak green", "green weak", "deutan mild", "most common type"],
            },
          ],
        },
        {
          label: "Blue and yellow deficiency",
          synonyms: ["blue yellow colour blind", "blue yellow color blind", "tritan", "rare"],
          options: [
            {
              value: "tritanopia",
              label: "Tritanopia",
              synonyms: ["blue blind", "no blue", "tritan", "missing S cone"],
            },
            {
              value: "tritanomaly",
              label: "Tritanomaly",
              synonyms: ["weak blue", "blue weak", "tritan mild", "partial blue"],
            },
          ],
        },
        {
          label: "No colour vision",
          synonyms: ["monochrome", "grayscale vision", "total colour blindness"],
          options: [
            {
              value: "achromatopsia",
              label: "Achromatopsia",
              synonyms: [
                "monochromacy",
                "greyscale",
                "grayscale",
                "black and white",
                "no colour at all",
              ],
            },
          ],
        },
      ],
    },
    {
      kind: "boolean",
      id: "contrast",
      label: "Check adjacent pairs",
      default: true,
    },
  ],
  copy: {
    what: "Runs a palette through seven colour vision deficiencies and gives you the simulated hex for each one: protanopia, protanomaly, deuteranopia, deuteranomaly, tritanopia, tritanomaly, and achromatopsia. Every colour is decoded from sRGB to linear light, transformed by the published Machado, Oliveira and Fernandes (2009) matrix for that deficiency, then re-encoded, so the output is a real simulation rather than a hue rotation. With the pair check on it also reports the WCAG contrast ratio of each neighbouring pair before and after simulation, plus a CIE76 deltaE, and flags any pair that collapses into near identical colours.",
    how: "Paste your palette with one colour per line, or separated by commas or spaces. Hex short form (#f00), hex long form (#1d4ed8), bare six digit hex, and rgb(29, 78, 216) all parse. Leave the deficiency on All seven for a full comparison, or pick a single one to get a compact original to simulated row per colour. Every row has its own copy button, so you can paste the simulated palette straight into a design file or a ticket.",
    why: "The well known simulators either want an upload, cap you at a few images a day, or wrap the answer in ads. This one is a plain text box: your inputs never leave your device, there is no sign in, and there is no limit on how many palettes you check. It also does the part most simulators skip, which is telling you which specific pair of your colours stops being distinguishable and by how much.",
    faq: [
      {
        q: "Which simulation matrices does this use, and why do results differ from other tools?",
        a: "It uses the Machado, Oliveira and Fernandes (2009) matrices: the severity 1.0 rows for protanopia, deuteranopia, and tritanopia, and the severity 0.5 rows for the three anomalous types. Achromatopsia uses Rec. 709 luminance weights. Other simulators often use the older Brettel or Vienot models, or apply the matrix to gamma encoded sRGB instead of linear light, and both choices shift the result by a visible amount. This tool decodes with the exact piecewise sRGB transfer function before transforming.",
      },
      {
        q: "Can it simulate images, not just palettes?",
        a: "Yes. Image preview runs in the page using the same matrices on the same linear RGB pipeline, pixel by pixel on a canvas. Nothing is uploaded and no image ever leaves your device, so the file size limit is whatever your browser can hold in memory.",
      },
      {
        q: "What does the hard to tell apart flag actually mean?",
        a: "For each neighbouring pair it computes a CIE76 deltaE in Lab space between the two simulated colours. A deltaE under 12 means the pair reads as roughly the same colour to someone with that deficiency, so the flag is a prompt to change one of them or add a non colour cue such as a shape, label, or line style.",
      },
    ],
  },
};
