import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "pixel-circle-generator",
  matrixSlug: "minecraft-pixel-circle-generator",
  icon: "Grid3x3",
  name: "Minecraft Pixel Circle Generator",
  description:
    "Block grid circles and ellipses at any size from 1 to 256, filled or outlined, with an exportable block count and per-row run lengths.",
  category: "Minecraft",
  keywords: [
    "minecraft circle generator",
    "minecraft ellipse generator",
    "pixel circle chart",
    "minecraft circle blocks",
    "minecraft round build",
    "circle block count minecraft",
  ],
  searchTerms: [
    "how to build a circle in minecraft",
    "minecraft circle chart",
    "block circle generator",
    "minecraft dome base circle",
    "circle template minecraft",
    "how many blocks for a circle",
    "minecraft roof circle",
    "pixel art circle",
    "minecraft build helper",
    "minecraft tower circle",
  ],
  input: "none",
  output: "application/json",
  options: [
    {
      kind: "number",
      id: "width",
      label: "Width (diameter)",
      default: 16,
      min: 1,
      max: 256,
      step: 1,
    },
    {
      kind: "number",
      id: "height",
      label: "Height (diameter, ellipse only)",
      default: 16,
      min: 1,
      max: 256,
      step: 1,
    },
    {
      kind: "select",
      id: "mode",
      label: "Fill",
      default: "filled",
      options: [
        { value: "filled", label: "Filled", synonyms: ["solid", "disk", "floor"] },
        { value: "outline", label: "Outline", synonyms: ["ring", "wall", "hollow"] },
      ],
    },
    {
      kind: "number",
      id: "thickness",
      label: "Outline thickness",
      default: 1,
      min: 1,
      max: 128,
      step: 1,
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Generates a block-grid circle or ellipse for any width and height from 1 to 256, filled or as a ring of a chosen thickness, using the same block-center midpoint rasterizer that the classic Minecraft circle and ellipse chart generators use. Reports the exact block total and, for build planning, the run of filled blocks in every row.",
    how: "Set a width (and a different height for an ellipse), choose filled or outline, and for an outline pick a wall thickness. The grid, block count, and row-by-row breakdown update live. Copy the grid as ASCII art to paste into a text file, or copy the run-length list to lay it out block by block on site.",
    why: "Most circle generator sites give one aesthetic circle at a time with no way to see the underlying block counts or get the raw grid out. This one shows the exact rasterized grid at any size up to 256 blocks, both fill modes with a real thickness control, and the row run lengths a builder actually needs to place blocks efficiently, plus a working copy of the pattern as text. It runs entirely in your browser: your files and inputs never leave your device.",
    faq: [
      {
        q: "How many blocks does a diameter 5 circle need?",
        a: "21 for a filled circle, 12 for a 1 block thick outline. Small diameters look chunky because a circle only a few blocks across cannot show much curvature: diameter 1 through 3 render as solid squares (1, 4, and 9 blocks), and the shape starts reading as a circle from about diameter 4 or 5 on.",
      },
      {
        q: "Can I build an ellipse instead of a circle?",
        a: "Yes. Set width and height to different values and the generator rasterizes a true ellipse on that footprint rather than stretching a circle. This is useful for domes and roofs that need to fit a rectangular building rather than a square one.",
      },
      {
        q: "How do I actually place the blocks in the world?",
        a: "Copy the ASCII art and read it top to bottom, left to right, treating each # as a block and each . as empty, or copy the row run lengths, which give the starting column and block count for every row so you can lay each row out as one straight run instead of placing blocks one at a time from a picture.",
      },
    ],
  },
};
