import type { ToolMeta } from "../types";

/**
 * The background, frame, and aspect option values below are literal copies of
 * the ids and labels in `./index` (BACKGROUNDS, FRAME_KINDS, ASPECTS), not an
 * import from it. Meta is imported eagerly by the registry on every page load
 * while the logic module is lazy loaded per tool, so meta must never import
 * logic (see the ToolMeta docblock in ../types). `index.test.ts` asserts this
 * file's option values stay in sync with the logic module's source of truth.
 */
export const meta: ToolMeta = {
  slug: "screenshot-beautifier",
  matrixSlug: "beautify",
  icon: "Frame",
  name: "Screenshot Beautifier",
  description: "Frame code and screenshots with padding, a window chrome, and a gradient background.",
  category: "Capture",
  keywords: [
    "screenshot beautifier",
    "pretty screenshot background",
    "add gradient background to screenshot",
    "mac window frame screenshot",
    "code screenshot generator",
    "carbon alternative",
  ],
  searchTerms: [
    "ray.so alternative",
    "shots.so alternative",
    "cleanshot background",
    "screenshot padding",
    "browser mockup frame",
    "window mockup screenshot",
    "gradient wallpaper for screenshot",
    "twitter card screenshot",
    "og image screenshot",
  ],
  input: "image/*",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "background",
      label: "Background",
      default: "sunset",
      options: [
        { value: "sunset", label: "Sunset", synonyms: ["warm gradient", "orange pink gradient"] },
        { value: "ocean", label: "Ocean", synonyms: ["blue teal gradient", "cool gradient"] },
        { value: "aurora", label: "Aurora", synonyms: ["mesh gradient", "colorful blobs", "northern lights"] },
        { value: "peach", label: "Peach", synonyms: ["soft pastel", "pink cream gradient"] },
        { value: "midnight", label: "Midnight", synonyms: ["dark blue gradient", "night sky"] },
        { value: "slate", label: "Slate", synonyms: ["gray solid", "neutral background"] },
        { value: "lime", label: "Lime", synonyms: ["green gradient", "fresh green"] },
        { value: "candy", label: "Candy", synonyms: ["pink purple mesh", "vibrant mesh gradient"] },
        { value: "mono-light", label: "Mono light", synonyms: ["white background", "plain light"] },
        { value: "mono-dark", label: "Mono dark", synonyms: ["black background", "plain dark"] },
        {
          value: "transparent",
          label: "Transparent",
          synonyms: ["no background", "alpha channel", "png transparency"],
        },
        { value: "custom", label: "Custom", synonyms: ["pick your own color", "custom gradient", "brand colors"] },
      ],
    },
    {
      kind: "select",
      id: "frame",
      label: "Window frame",
      default: "mac",
      options: [
        { value: "none", label: "No frame", synonyms: ["no frame", "flat", "no chrome", "just the image"] },
        { value: "mac", label: "macOS window", synonyms: ["macos", "traffic lights", "apple window"] },
        {
          value: "windows",
          label: "Windows window",
          synonyms: ["windows 11", "windows 10", "pc window", "minimize maximize close"],
        },
        {
          value: "browser-light",
          label: "Browser (light)",
          synonyms: ["chrome window", "url bar", "address bar", "browser mockup", "light browser"],
        },
        {
          value: "browser-dark",
          label: "Browser (dark)",
          synonyms: ["dark browser", "dark mode browser", "url bar dark"],
        },
      ],
    },
    {
      kind: "number",
      id: "padding",
      label: "Padding (px)",
      default: 64,
      min: 0,
      max: 400,
      step: 4,
    },
    {
      kind: "number",
      id: "cornerRadius",
      label: "Corner radius (px)",
      default: 12,
      min: 0,
      max: 48,
      step: 1,
    },
    {
      kind: "select",
      id: "aspect",
      label: "Canvas shape",
      default: "auto",
      options: [
        { value: "auto", label: "Auto (fit the frame)", synonyms: ["fit the image", "no forced ratio"] },
        { value: "1:1", label: "Square (1:1)", synonyms: ["square", "instagram square"] },
        { value: "4:3", label: "Classic (4:3)", synonyms: ["classic ratio", "standard photo ratio"] },
        { value: "16:9", label: "Widescreen (16:9)", synonyms: ["widescreen", "youtube thumbnail ratio"] },
        {
          value: "twitter(16:9)",
          label: "Twitter or X card (16:9)",
          synonyms: ["twitter card", "x card", "tweet image size"],
        },
        {
          value: "og(1.91:1)",
          label: "Open Graph image (1.91:1)",
          synonyms: ["open graph", "link preview image", "facebook share image", "linkedin share image"],
        },
      ],
    },
    {
      kind: "boolean",
      id: "shadow",
      label: "Drop shadow",
      default: true,
    },
    {
      kind: "text",
      id: "title",
      label: "Window title or URL",
      default: "",
      placeholder: "e.g. myapp.com/dashboard",
    },
  ],
  copy: {
    what: "Wraps a screenshot or a code capture in the padding, gradient background, and window chrome that turn a flat clipboard image into something worth posting. Twelve background presets cover warm gradients, cool gradients, layered mesh washes, and flat light or dark fills, plus a transparent option and a custom color. Five frame styles range from no chrome at all to a macOS traffic light window, a Windows title bar, and a browser bar with a fake address pill you can fill with your own URL. Padding, corner radius, drop shadow, and a forced canvas shape for social cards are all adjustable, and the composited result exports as a PNG or JPEG at 1x or 2x.",
    how: "Drop a screenshot on the panel, paste one from the clipboard, or pick a file. Choose a background and a frame, adjust the padding and corner radius until the image sits the way you want, and type a window title or URL if the frame has a title bar. Pick a canvas shape when you need an exact size for a tweet or a link preview card, then export the flattened image or copy it straight to the clipboard.",
    why: "Sites like this normally ask for an account, add a watermark past a few free exports, or upload the screenshot to a server before you have picked a background. This runs entirely in the page: your files and inputs never leave your device, there is no account, no watermark, and no export limit. The presets are picked to look good on both a light app screenshot and a dark terminal capture, and the browser frame's URL pill is a real editable field, not a fixed placeholder.",
    faq: [
      {
        q: "Is my screenshot uploaded anywhere?",
        a: "No. The image is decoded, composited with the background and frame, and re-encoded entirely in this tab, so your files and inputs never leave your device. There is no server copy and closing the tab discards everything.",
      },
      {
        q: "Can I match the exact size Twitter, LinkedIn, or Open Graph expect for a link preview?",
        a: "Yes. The canvas shape option forces the exported image to 16:9 for a Twitter or X card, or 1.91:1 (the same ratio as the standard 1200x630 Open Graph image) for Facebook and LinkedIn link previews, padding the frame evenly to hit the ratio exactly rather than cropping it.",
      },
      {
        q: "Can I use my own colors instead of the presets?",
        a: "Yes. The Custom background gives you direct color pickers in the panel for your own gradient or solid fill, and if you want a fully transparent canvas instead, pick the Transparent preset and export as a PNG to keep the alpha channel.",
      },
    ],
  },
};
