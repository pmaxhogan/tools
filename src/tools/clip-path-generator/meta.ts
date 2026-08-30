import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "clip-path-generator",
  icon: "SquareScissors",
  name: "Clip Path Generator",
  description:
    "Drag shape handles over your own image and copy the matching CSS clip-path or SVG path.",
  category: "Dev",
  keywords: [
    "css clip-path generator",
    "clip path polygon editor",
    "clip-path shapes",
    "css shape cutout",
    "clip path to svg path",
    "inset clip path rounded",
    "circle clip path css",
  ],
  searchTerms: [
    "polygon() css",
    "image mask css",
    "diagonal section divider css",
    "hexagon avatar css",
    "star shape css",
    "speech bubble css shape",
    "clippy clip path maker",
    "svg path from clip path",
    "blob shape generator",
    "arrow breadcrumb css",
  ],
  input: "text/plain",
  output: "text/plain",
  inputOptional: {
    label: "Paste an existing clip-path",
    hint: "Paste a value like polygon(50% 0%, 100% 100%, 0% 100%) or circle(40% at 50% 50%) and it is read back into draggable handles. Leave it empty to start from a preset.",
  },
  options: [
    {
      kind: "select",
      id: "preset",
      label: "Preset",
      default: "triangle",
      groups: [
        {
          label: "Straight edges",
          synonyms: ["polygon", "angular", "geometric", "flat"],
          options: [
            {
              value: "triangle",
              label: "Triangle",
              synonyms: ["three sides", "arrow up", "wedge"],
            },
            {
              value: "rhombus",
              label: "Rhombus",
              synonyms: ["diamond", "kite", "four points", "tilted square"],
            },
            {
              value: "parallelogram",
              label: "Parallelogram",
              synonyms: ["slanted", "skew", "diagonal", "section divider"],
            },
            {
              value: "trapezoid",
              label: "Trapezoid",
              synonyms: ["tapered", "wedge", "perspective"],
            },
            {
              value: "hexagon",
              label: "Hexagon",
              synonyms: ["six sides", "honeycomb", "avatar", "badge"],
            },
          ],
        },
        {
          label: "Pointed and irregular",
          synonyms: ["decorative", "fun", "organic"],
          options: [
            { value: "star", label: "Star", synonyms: ["five point", "rating", "sparkle"] },
            {
              value: "arrow",
              label: "Arrow",
              synonyms: ["pointer", "next", "direction", "right arrow"],
            },
            {
              value: "chevron",
              label: "Chevron",
              synonyms: ["breadcrumb", "banner", "ribbon", "step indicator"],
            },
            {
              value: "bubble",
              label: "Message bubble",
              synonyms: ["speech", "chat", "tooltip", "callout", "tail"],
            },
            {
              value: "blob",
              label: "Blob",
              synonyms: ["organic", "irregular", "amoeba", "splat", "soft"],
            },
          ],
        },
        {
          label: "Curved and rectangular",
          synonyms: ["basic shapes", "rounded", "geometry"],
          options: [
            {
              value: "circle",
              label: "Circle",
              synonyms: ["round", "avatar", "dot", "ellipse equal"],
            },
            {
              value: "ellipse",
              label: "Ellipse",
              synonyms: ["oval", "stretched circle", "arch"],
            },
            {
              value: "rounded-inset",
              label: "Rounded inset",
              synonyms: ["rectangle", "padding", "rounded corners", "frame", "border radius"],
            },
          ],
        },
      ],
    },
    {
      kind: "select",
      id: "format",
      label: "Output",
      default: "both",
      options: [
        { value: "css", label: "CSS", synonyms: ["clip-path", "declaration", "stylesheet"] },
        { value: "svg", label: "SVG path", synonyms: ["path d", "vector", "figma", "icon"] },
        { value: "both", label: "Both", synonyms: ["everything", "css and svg"] },
      ],
    },
    { kind: "number", id: "width", label: "SVG box width", default: 200, min: 1, max: 10000 },
    { kind: "number", id: "height", label: "SVG box height", default: 200, min: 1, max: 10000 },
  ],
  examples: [
    { label: "Triangle", input: "", opts: { preset: "triangle" } },
    { label: "Message bubble", input: "", opts: { preset: "bubble" } },
    { label: "Read back an existing shape", input: "polygon(25% 0%, 100% 0%, 75% 100%, 0% 100%)" },
  ],
  http: { method: "GET", contentType: "text/plain" },
  copy: {
    what: "Builds a CSS clip-path by dragging handles over a preview, which can be a plain color block or an image you drop in so you can see exactly what gets cut away. It covers all four basic shapes: polygon with as many points as you want, circle, ellipse, and inset with rounded corners. Every coordinate is a percentage of the element's own box, so the shape holds at any size, and the same shape can be exported as an SVG path for the places clip-path cannot reach.",
    how: "Pick a preset, then drag the handles. Click an edge to add a point, press Delete with a handle focused to remove it, and use the arrow keys to nudge a point one percent at a time. Drop an image onto the preview to check the shape against real content. Copy the CSS declaration, or switch the output to the SVG path if you need the shape as vector geometry.",
    why: "The clip-path builders people use most either paywall the shape library or lose your work when you reload. This one keeps the whole shape in the URL fragment, so a link reproduces exactly what you drew, reads an existing value back so you can edit what is already in your stylesheet, and exports an SVG path with the circle radius resolved correctly against the box diagonal. Your image never leaves the page: your files and inputs never leave your device.",
    faq: [
      {
        q: "Why is my circle clip-path smaller than I expected?",
        a: "A percentage radius in circle() does not resolve against the width. It resolves against the box diagonal divided by the square root of two, which only equals the width when the box is square. On a 200 by 100 box a 50 percent radius comes out at about 79, not 100. The SVG export here does the same arithmetic, so the exported path matches what the browser draws.",
      },
      {
        q: "Can a clip-path have curved edges?",
        a: "polygon() is straight lines only. For curves you have three options: circle() and ellipse() for the simple cases, inset() with a round clause for rounded rectangles, or path() and the newer shape() function for anything else. Support for shape() is still thin, so for a curved cutout today the usual answer is an SVG path, which is why this tool exports one.",
      },
      {
        q: "Does clip-path affect layout or clicks?",
        a: "It changes what is painted and what is hit tested, but not layout. The element still takes up its full box, so the space outside the shape stays reserved and neighbors do not move in. Clicks land only inside the visible shape, which is usually what you want but does mean a link clipped down to a small triangle has a small target. Content is clipped, not reflowed, so text can still be cut mid word.",
      },
    ],
  },
};
