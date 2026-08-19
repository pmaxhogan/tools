import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "screen-ruler",
  matrixSlug: "ruler",
  icon: "Ruler",
  name: "Screen Ruler",
  description: "Measure pixels and pick colors anywhere inside this browser tab.",
  category: "Platform",
  keywords: [
    "screen ruler",
    "online pixel ruler",
    "measure pixels on screen",
    "pixel ruler browser",
    "measure distance in screenshot",
    "on screen ruler",
  ],
  searchTerms: [
    "ruler tool",
    "pixel measure",
    "screen measure",
    "color picker",
    "eyedropper",
    "screenshot ruler",
    "device pixel ratio",
    "dpi calibration",
    "aspect ratio calculator",
  ],
  input: "application/json",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "units",
      label: "Units",
      default: "px",
      options: [
        { value: "px", label: "Pixels", synonyms: ["px", "pixel", "pixels", "screen pixels"] },
        {
          value: "mm",
          label: "Millimeters",
          synonyms: ["mm", "millimeter", "millimeters", "millimetre", "millimetres"],
        },
        {
          value: "cm",
          label: "Centimeters",
          synonyms: ["cm", "centimeter", "centimeters", "centimetre", "centimetres"],
        },
        { value: "in", label: "Inches", synonyms: ["in", "inch", "inches"] },
      ],
    },
    {
      kind: "number",
      id: "dpr",
      label: "Device pixel ratio (manual text input only)",
      default: 1,
      min: 0.5,
      max: 4,
      step: 0.1,
    },
  ],
  copy: {
    what: "Measures pixels and reads colors from anything rendered inside this browser tab: the page itself, or a screenshot you drop or paste in. Drag the on-page ruler overlay for a live readout of distance, angle, bounding box, and aspect ratio, or drag a calibration line against a known real-world length (a credit card, a printed ruler) to convert pixel distances into millimeters, centimeters, and inches. A web page cannot see or measure anything outside its own tab, so measuring other sites needs the Bookmarklet Shelf's pixel ruler bookmarklet instead.",
    how: "Open the ruler overlay and drag between two points to read distance, angle, and size, or drop a screenshot in first and measure inside it. Hold a real object of known size (a credit card is 85.60 mm wide) up to the screen and drag the calibration line across it to unlock accurate millimeter, centimeter, and inch readings. Switch to the color picker to sample a pixel and get its hex value, contrast ratio, and nearest named color. Every field also accepts manual input: paste two points as x1,y1 x2,y2 or JSON.",
    why: "Most online pixel rulers are a single fixed-length bar meant for calibrating your monitor once, not a general measuring tool, and most color pickers are separate sites with their own ads and uploads. This combines a draggable ruler, angle and aspect ratio readouts, screen-and-screenshot calibration, and a contrast-checking color picker in one page, and your files and inputs never leave your device.",
    faq: [
      {
        q: "Can this measure things in another window or another website?",
        a: "No. A web page can only see and measure content rendered inside its own browser tab, so it cannot reach into another window, another tab, or another site. To measure something on another page, install the pixel ruler bookmarklet from the Bookmarklet Shelf and run it there, or take a screenshot of that page and drop the screenshot into this tool.",
      },
      {
        q: "How accurate are the millimeter and inch readings?",
        a: "Only as accurate as your calibration. Without it, real-world units assume the CSS standard of 96 pixels per inch, which rarely matches your actual screen's pixel density. Calibrating against a known length, such as an 85.60 mm credit card held up to the screen, corrects for your specific display and gives a real measurement.",
      },
      {
        q: "What is device pixel ratio (DPR) and why does it matter here?",
        a: "DPR is how many physical pixels your display draws for each CSS pixel a web page measures, commonly 1 on standard displays and 2 or 3 on Retina and HiDPI screens. This tool always measures in CSS pixels, the same units JavaScript and this ruler use, and reports the physical pixel count alongside it so you can see both.",
      },
    ],
  },
};
