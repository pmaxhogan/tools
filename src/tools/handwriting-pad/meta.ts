import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "handwriting-pad",
  matrixSlug: "handwriting",
  icon: "PenTool",
  name: "Handwriting Pad",
  description: "Write or draw with pressure sensitive ink, then export it as SVG or PNG.",
  category: "Images",
  keywords: [
    "online drawing pad",
    "signature maker online free",
    "handwriting to svg",
    "stylus test online",
    "pen pressure drawing canvas",
    "sketch pad browser",
    "draw signature and download png",
    "transparent png signature",
  ],
  searchTerms: [
    "ink canvas",
    "whiteboard",
    "scratch pad",
    "doodle",
    "wacom test",
    "apple pencil test",
    "signature pad",
    "draw my name",
    "write with mouse",
    "vector pen tool",
    "svg drawing export",
    "annotate blank page",
  ],
  input: "none",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "guides",
      label: "Paper",
      default: "lines",
      options: [
        { value: "none", label: "Blank", synonyms: ["plain", "empty", "no guides", "unlined"] },
        {
          value: "lines",
          label: "Ruled lines",
          synonyms: ["lined", "notebook", "writing lines", "ruled paper"],
        },
        {
          value: "signature",
          label: "Signature line",
          synonyms: ["baseline", "sign here", "signature guide", "x line"],
        },
      ],
    },
    {
      kind: "select",
      id: "shape",
      label: "Canvas shape",
      default: "4 / 3",
      options: [
        { value: "16 / 9", label: "Wide", synonyms: ["16:9", "landscape", "short", "banner"] },
        { value: "4 / 3", label: "Standard", synonyms: ["4:3", "default", "medium"] },
        { value: "3 / 4", label: "Tall", synonyms: ["3:4", "portrait", "page", "long"] },
      ],
    },
    {
      kind: "slider",
      id: "baseWidth",
      label: "Pen width",
      default: 3,
      min: 1,
      max: 14,
      step: 0.5,
    },
    { kind: "boolean", id: "pressure", label: "Vary width with pressure", default: true },
  ],
  copy: {
    what: "A drawing surface that follows a stylus properly: every pointer sample is read, including the ones your browser batches up between frames, and pen pressure drives how thick the line gets. Strokes are smoothed with midpoint curves so handwriting looks like handwriting instead of a chain of straight segments. Export the result as an SVG you can scale or edit, a PNG at 1x or 2x with a transparent background, or a JSON file that loads back into the pad. There is no text recognition here, and the FAQ below explains why.",
    how: "Draw with a stylus, a finger, or a mouse. Pick a pen color and width, and choose blank, ruled, or a signature baseline for the paper underneath, which is a guide only and never lands in the export. Undo removes the last stroke and Clear empties the pad. When you are done, use Copy as SVG to put the vector on your clipboard, or download an SVG or PNG.",
    why: "Most drawing pads on the web want an account before they let you save, stamp a logo into the corner, or hand your ink to a server to render a file you could have made locally. This one draws and exports in the tab: your files and inputs never leave your device. It is also honest about the thing every other handwriting page implies and none of them deliver, which is turning your writing back into text.",
    faq: [
      {
        q: "Does it convert my handwriting to text?",
        a: "No. Reading handwriting reliably takes a trained recognition model, and the small ones that would fit in a page download are poor enough at cursive and mixed scripts that the output is usually worse than retyping. Rather than ship a feature that quietly fails on half of what people write, this tool is a drawing surface with good exports. If you need recognition, your operating system probably has it built in for stylus input.",
      },
      {
        q: "Why is my line the same thickness everywhere?",
        a: "Pressure comes from the device, not the page. A mouse and most trackpads report no pressure at all, so the pad draws at the width you picked and does not invent a taper. A stylus on a tablet, a Wacom pen, an Apple Pencil, or a Surface Pen reports real pressure and the line thickens and thins with it. You can also turn the pressure response off if you want a perfectly even line.",
      },
      {
        q: "What is the difference between the SVG and the PNG export?",
        a: "The SVG is vector: it stays sharp at any size and can be recolored or edited in a vector editor, which is what you want for a logo, a signature, or anything going into print. The PNG is pixels at the size you export, offered at 1x and 2x, with a transparent background unless you set a paper color, which is what you want for pasting into a document or a chat. Both come from the same strokes, so they look the same.",
      },
    ],
  },
};
