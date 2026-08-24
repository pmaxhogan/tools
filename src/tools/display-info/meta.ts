import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "display-info",
  icon: "Monitor",
  name: "Display Info",
  description:
    "Live readout of your screen resolution, pixel density, refresh rate, color capabilities, and input features.",
  category: "Network",
  keywords: [
    "display info",
    "screen resolution",
    "monitor info",
    "what is my screen resolution",
    "dpi checker",
    "ppi calculator",
    "retina display check",
    "refresh rate test",
  ],
  searchTerms: [
    "screen resolution",
    "monitor info",
    "dpi",
    "ppi",
    "retina",
    "refresh rate",
    "hz",
    "color gamut",
    "hdr",
    "aspect ratio",
    "pixel density",
    "screen details",
    "multi monitor",
    "device pixel ratio",
    "screen test",
  ],
  input: "application/json",
  output: "application/json",
  copy: {
    what: "Reads your screen and browser live: resolution, available area, window size, device pixel ratio with physical pixel count, aspect ratio, color depth, orientation, a measured refresh rate, color gamut (sRGB, Display P3, Rec. 2020), HDR support, prefers-color-scheme and prefers-contrast, reduced motion preference, pointer and hover input type, CPU core count, approximate device memory, network connection info, and connected display layout when the browser grants permission for multiple monitors.",
    how: "Open the page: every value fills in automatically, no input needed. Values update live as you resize the window, rotate the screen, or move it to another monitor. Each row has its own copy button, and a full copy button covers the whole readout at once.",
    why: 'Most "screen resolution" sites show one or two numbers behind ad-heavy layouts and stop there. This one pulls every modern screen and media-query API into a single readout, including refresh rate measurement and multi-monitor layout that most sites skip entirely, and your files and inputs never leave your device.',
    faq: [
      {
        q: 'Why do some rows say "Not supported in this browser"?',
        a: "Several of these come from newer or Chromium-only APIs (device memory, the Screen Details API for multi-monitor layout, network connection info). When a browser does not expose an API, the row says so honestly instead of guessing.",
      },
      {
        q: "How is the refresh rate measured?",
        a: "The page samples animation frame timestamps for about a second and computes the average interval between frames. It is a real measurement, not a value read from a system API, so it can be off by a few Hz and is shown as an approximation.",
      },
      {
        q: "Why does it ask for permission to see other monitors?",
        a: "Listing every connected display and its position uses the Screen Details API, which requires an explicit permission grant since it reveals your desktop layout. Without that permission, the tool still shows full detail for the current screen.",
      },
    ],
  },
};
