import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "mouse-tester",
  matrixSlug: "mouse",
  icon: "Mouse",
  name: "Mouse Polling Rate and DPI Tester",
  description: "Measure real polling rate and actual counts per inch.",
  category: "Testers",
  keywords: [
    "mouse polling rate test",
    "mouse hz test",
    "dpi analyzer",
    "mouse dpi test online",
    "polling rate checker",
    "mouse button test",
    "mouse acceleration test",
  ],
  searchTerms: [
    "gaming mouse test",
    "mouse cpi test",
    "mouse smoothing test",
    "mouse debounce test",
    "double click test",
    "mouse jitter test",
    "sensor test online",
    "mouse click speed test",
  ],
  input: "application/json",
  output: "application/json",
  options: [
    {
      kind: "number",
      id: "physicalDistanceCm",
      label: "Physical distance for DPI run",
      default: 10,
      min: 1,
      max: 50,
    },
    {
      kind: "select",
      id: "units",
      label: "Distance units",
      default: "cm",
      options: [
        { value: "cm", label: "Centimeters", synonyms: ["cm", "metric"] },
        { value: "in", label: "Inches", synonyms: ["in", "inches", "imperial"] },
      ],
    },
  ],
  copy: {
    what: "Measures four things about a mouse that manufacturer specs do not verify: actual polling rate in Hz from real pointer event timing, actual DPI (counts per inch) from a measured physical move, whether the OS or driver is applying pointer acceleration, and click and scroll health, including double-click intervals and switch bounce on worn buttons.",
    how: "Run each test in the live panel: move the mouse continuously for a few seconds for the polling rate reading, lock the pointer and move it a measured distance with a ruler for DPI, repeat that move once slowly and once quickly for the acceleration check, and click or scroll to record button and wheel behavior. Each run produces a JSON report that this page turns into a labeled breakdown.",
    why: "Most polling rate testers only show a live graph with no way to see the underlying numbers, and most DPI checkers just echo back whatever the mouse driver reports instead of measuring it. This measures polling rate and DPI directly from real browser events, entirely on your device, with no ads and no account.",
    faq: [
      {
        q: "My mouse is rated 1000 Hz but this reads 125 Hz. Why?",
        a: "Browsers commonly coalesce pointermove delivery to the display's refresh rate, so a page reading raw event timestamps can undercount a fast mouse. Use a Chromium browser, since it exposes getCoalescedEvents on pointer events, which recovers the individual hardware samples the display-rate events were bundled from.",
      },
      {
        q: "How does the DPI test actually work?",
        a: "With the pointer locked, movementX reports the mouse sensor's raw counts instead of scaled CSS pixels. Moving the mouse a known physical distance and summing those counts, then dividing by the distance in inches, gives the sensor's real counts per inch, which is what DPI means.",
      },
      {
        q: "What does the acceleration check tell me?",
        a: "It compares total counts from moving the mouse the same physical distance slowly versus quickly. If counts stay close between the two runs, movement is linear (1:1 with distance). If the fast run reports noticeably more counts, the OS or driver is scaling movement with speed, commonly called pointer acceleration or enhance pointer precision.",
      },
    ],
  },
};
