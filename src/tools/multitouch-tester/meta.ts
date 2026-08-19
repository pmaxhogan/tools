import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "multitouch-tester",
  matrixSlug: "touch",
  icon: "Hand",
  name: "Multitouch Tester",
  description: "Visualize simultaneous touch points, dead zones, and stylus pressure.",
  category: "Testers",
  keywords: [
    "multitouch test",
    "touch screen test online",
    "how many fingers can my screen detect",
    "touch point tester",
    "touchscreen dead zone test",
    "stylus pressure test",
  ],
  searchTerms: [
    "touch tester",
    "finger tester",
    "digitizer test",
    "touchscreen calibration",
    "pinch zoom test",
    "pen pressure test",
    "how many touch points",
    "pointer events tester",
  ],
  input: "application/json",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "view",
      label: "View",
      default: "live",
      options: [
        {
          value: "live",
          label: "Live points",
          synonyms: ["current touches", "fingers now", "active points", "realtime"],
        },
        {
          value: "coverage",
          label: "Coverage grid",
          synonyms: ["dead zone", "dead spot", "sweep test", "heatmap", "digitizer coverage"],
        },
        {
          value: "pressure",
          label: "Pressure stats",
          synonyms: ["stylus pressure", "pen pressure", "force", "pressure sensitivity"],
        },
      ],
    },
    {
      kind: "number",
      id: "gridCols",
      label: "Coverage grid columns",
      default: 10,
      min: 5,
      max: 20,
      step: 1,
    },
  ],
  copy: {
    what: "Tracks every simultaneous touch, pen, and mouse pointer your screen reports, live: each point's coordinates, contact radius, rotation angle, and pressure where the hardware provides it, plus the highest number of fingers seen at once this session. A coverage view sweeps the whole screen into a grid to reveal dead zones the digitizer never registers, and a pressure view checks whether a stylus reports real pressure data or a flat, unsupported value.",
    how: "Open the tool on the touchscreen or with the stylus you want to test, then touch or press anywhere on the capture surface with as many fingers, a pen, or a mouse as you have. Watch the live readout update per pointer, switch to the coverage view and drag a finger across the entire screen to check for unresponsive spots, or switch to the pressure view and vary how hard you press with a stylus.",
    why: "Most online multitouch demos cap out at showing dots on screen with no numbers behind them, and none of them check for dead zones or confirm whether your stylus is actually reporting pressure versus a constant fallback value. This one reads the raw pointer data, works offline, and never sends your input anywhere.",
    faq: [
      {
        q: "Why does my phone only track 5 or 10 touches even though I am pressing more fingers?",
        a: "The touchscreen controller itself has a hardware limit on simultaneous contacts, commonly 5 or 10 depending on the panel, and the operating system cannot report more points than the hardware detects, no matter how many fingers are physically touching the glass.",
      },
      {
        q: "What counts as a dead zone in the coverage test?",
        a: "A cell in the coverage grid that never registers a touch even after you sweep a finger across it, usually a strip near a screen edge, a bezel seam, or a spot where the digitizer's sensing grid has degraded or was damaged.",
      },
      {
        q: "Why does the pressure view say my stylus does not support pressure?",
        a: "Only styluses with an active pressure sensor report a value that changes as you press harder, such as many Wacom, Apple Pencil, or Surface Pen models; a passive stylus or a finger reports either no pressure field at all or a constant value like 0 or 0.5, which this tool treats as unsupported.",
      },
    ],
  },
};
