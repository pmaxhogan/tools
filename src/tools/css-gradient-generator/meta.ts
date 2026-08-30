import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "css-gradient-generator",
  icon: "Rainbow",
  name: "CSS Gradient Generator",
  description:
    "Build linear, radial, and conic CSS gradients visually, pick the interpolation color space, and copy the CSS.",
  category: "CSS",
  keywords: [
    "css gradient generator",
    "linear gradient css",
    "radial gradient generator",
    "conic gradient css",
    "mesh gradient css",
    "oklch gradient interpolation",
    "tailwind gradient arbitrary value",
  ],
  searchTerms: [
    "background image gradient",
    "colour stops", // spelling: allow
    "repeating linear gradient stripes",
    "gradient angle picker",
    "gradient colour space", // spelling: allow
    "css color interpolation method",
    "transparent gradient fade",
    "gradient generator no signup",
    "hard stop gradient",
    "gradient text background clip",
  ],
  input: "text/plain",
  output: "text/plain",
  inputOptional: {
    label: "Paste an existing gradient",
    hint: "Paste a value like linear-gradient(45deg, #ff0000, #0000ff) and it is read back into editable stops. Several comma separated gradients are read as stacked layers. Leave it empty to start from a preset.",
  },
  options: [
    {
      kind: "select",
      id: "preset",
      label: "Preset",
      default: "sunset",
      groups: [
        {
          label: "Linear",
          synonyms: ["straight", "angle", "two stop", "diagonal"],
          options: [
            { value: "sunset", label: "Sunset", synonyms: ["warm", "orange", "dusk", "peach"] },
            {
              value: "aurora",
              label: "Aurora",
              synonyms: ["northern lights", "blue green", "cool", "cyan"],
            },
            { value: "ocean", label: "Ocean", synonyms: ["sea", "blue", "vertical", "simple"] },
            {
              value: "peach",
              label: "Peach",
              synonyms: ["soft", "pastel", "low contrast", "behind text"],
            },
          ],
        },
        {
          label: "Radial and conic",
          synonyms: ["circle", "sweep", "angular", "center"],
          options: [
            {
              value: "spotlight",
              label: "Spotlight",
              synonyms: ["radial", "glow", "vignette", "off center", "sun"],
            },
            {
              value: "wheel",
              label: "Color wheel",
              synonyms: ["conic", "hue circle", "rainbow", "pie", "spectrum"],
            },
          ],
        },
        {
          label: "Stacked and repeating",
          synonyms: ["layers", "patterns", "multiple"],
          options: [
            {
              value: "mesh",
              label: "Mesh",
              synonyms: ["blobs", "multi layer", "blurry", "modern hero", "gradient mesh"],
            },
            {
              value: "stripes",
              label: "Stripes",
              synonyms: ["repeating", "hard stops", "bands", "barber pole", "pattern"],
            },
          ],
        },
      ],
    },
    {
      kind: "select",
      id: "interpolation",
      label: "Interpolation color space",
      default: "keep",
      groups: [
        {
          label: "Leave alone",
          synonyms: ["default", "no change"],
          options: [
            {
              value: "keep",
              label: "Keep what the preset uses",
              synonyms: ["default", "unchanged", "as is"],
            },
            {
              value: "none",
              label: "None: let the browser decide",
              synonyms: ["omit", "remove", "plain", "no in clause"],
            },
          ],
        },
        {
          label: "Perceptual",
          synonyms: ["modern", "even", "no gray middle", "uniform"],
          options: [
            {
              value: "oklch",
              label: "in oklch",
              synonyms: ["polar", "vivid middle", "hue rotation", "recommended"],
            },
            {
              value: "oklch longer hue",
              label: "in oklch longer hue",
              synonyms: ["around the wheel", "rainbow path", "long way"],
            },
            {
              value: "oklab",
              label: "in oklab",
              synonyms: ["rectangular", "smooth", "perceptual", "no hue shift"],
            },
          ],
        },
        {
          label: "Classic",
          synonyms: ["legacy", "traditional", "device"],
          options: [
            {
              value: "srgb",
              label: "in srgb",
              synonyms: ["default browser", "gamma", "classic", "muddy middle"],
            },
            {
              value: "srgb-linear",
              label: "in srgb-linear",
              synonyms: ["light linear", "physical", "photographic"],
            },
            { value: "hsl", label: "in hsl", synonyms: ["hue saturation lightness", "polar"] },
            {
              value: "display-p3",
              label: "in display-p3",
              synonyms: ["wide gamut", "p3", "hdr display", "saturated"],
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
          label: "rgba(255, 0, 0, 0.5)",
          synonyms: ["legacy", "comma", "classic", "widest support"],
        },
        {
          value: "hex",
          label: "#ff000080",
          synonyms: ["hex alpha", "eight digit hex", "short", "compact"],
        },
        {
          value: "modern",
          label: "rgb(255 0 0 / 50%)",
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
  ],
  examples: [
    { label: "Sunset", input: "", opts: { preset: "sunset" } },
    { label: "Mesh, three layers", input: "", opts: { preset: "mesh" } },
    {
      label: "Read back an existing gradient",
      input: "linear-gradient(to right, #ff9a44, #6a3093)",
    },
  ],
  http: { method: "GET", contentType: "text/plain" },
  copy: {
    what: "Builds linear, radial, and conic CSS gradients from a draggable stop bar, with an angle or center control, an optional repeating flag, and a per gradient interpolation color space. Because background-image can hold several gradients at once, the editor works on a stack of layers, which is how a mesh gradient is put together in plain CSS. A pasted value is read back into editable stops, and the output comes as both a CSS declaration and a Tailwind arbitrary value.",
    how: "Pick a preset or paste a gradient you already have, then drag the stops along the bar to move them and use the color field and opacity slider to change them. Add a stop by clicking the empty part of the bar, remove one with its delete button, and use the arrow keys once a stop handle has focus to nudge it a percent at a time. Change the type between linear, radial, and conic, set the angle or the center, then copy the CSS or the Tailwind value.",
    why: "Gradient builders usually stop at two stops, one layer, and the srgb interpolation the browser defaults to, which is exactly what makes a blue to yellow fade go gray in the middle. This one exposes the interpolation color space, keeps a real layer stack so mesh and overlay gradients are possible, and reads an existing value back so you can edit what is already in your stylesheet. It runs entirely in the page, so your files and inputs never leave your device.",
    faq: [
      {
        q: "Why does my gradient go gray in the middle?",
        a: "By default a browser interpolates in srgb, and the straight line between two saturated colors in that space passes close to gray. Adding an in oklch or in oklab clause tells the browser to interpolate in a perceptual space instead, which keeps the midpoint saturated. Support landed in Chrome 111, Safari 16.2, and Firefox 128, so a browser that does not understand the clause ignores the whole gradient: keep a plain background-color underneath as the fallback.",
      },
      {
        q: "How do I make a mesh gradient with CSS?",
        a: "Stack several radial gradients whose outer stops fade to a fully transparent version of their own color, then put a flat gradient or background color underneath. Fading to transparent rather than to the transparent keyword matters in older browsers, because transparent used to mean transparent black and left a gray halo. The mesh preset here shows the shape, and each blob is an editable layer.",
      },
      {
        q: "Do I still need vendor prefixes?",
        a: "No. Unprefixed linear-gradient, radial-gradient, and conic-gradient work in every browser released in the last decade, and the -webkit- and -moz- forms used a different, incompatible angle convention, so keeping them around is worse than dropping them. This tool never emits a prefixed value.",
      },
    ],
  },
};
