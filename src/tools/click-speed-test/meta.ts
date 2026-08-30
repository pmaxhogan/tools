import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "click-speed-test",
  icon: "Gauge",
  name: "Click Speed Test (CPS)",
  description:
    "Measure clicks per second over a 5, 10, 30, 60, or 100 second window, with a peak rate and a per second breakdown.",
  category: "Testers",
  keywords: [
    "click speed test",
    "cps test",
    "clicks per second",
    "click test 10 seconds",
    "click counter",
    "cps counter",
    "spacebar click test",
    "click speed checker",
  ],
  searchTerms: [
    "kohi click test",
    "jitter click test",
    "butterfly click test",
    "click per second test",
    "cps tester",
    "auto clicker check",
    "how fast can i click",
    "click challenge",
    "spacebar counter",
    "drag click test",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "duration",
      label: "Test length",
      default: "10",
      ui: "segmented",
      options: [
        { value: "5", label: "5s", synonyms: ["five seconds", "short", "sprint"] },
        { value: "10", label: "10s", synonyms: ["ten seconds", "standard", "kohi"] },
        { value: "30", label: "30s", synonyms: ["thirty seconds", "endurance"] },
        { value: "60", label: "60s", synonyms: ["sixty seconds", "one minute", "minute"] },
        { value: "100", label: "100s", synonyms: ["hundred seconds", "long", "marathon"] },
      ],
    },
    {
      kind: "select",
      id: "mode",
      label: "Input",
      default: "mouse",
      options: [
        {
          value: "mouse",
          label: "Mouse or touch",
          synonyms: ["click", "tap", "pointer", "trackpad"],
        },
        {
          value: "keyboard",
          label: "Keyboard (space)",
          synonyms: ["spacebar", "space bar", "key", "enter", "accessible"],
        },
      ],
    },
  ],
  copy: {
    what: "Counts how many times you can click in a fixed window and turns that into a clicks per second rate. Windows of 5, 10, 30, 60, and 100 seconds cover both a short sprint and a real endurance run. Alongside the average rate it reports your total clicks, the peak number of clicks landing in any single second, and a second by second breakdown, so a fast burst followed by a fade is visible instead of being averaged away. A keyboard mode counts the space bar instead of a mouse button.",
    how: "Pick a test length, then click the target to start. The timer begins on your first click, not on a countdown, so nothing is wasted waiting. Keep clicking until the window closes and the results appear underneath, including your rate, your peak second, and where that rate sits among ordinary clicking speeds. Press the target with the space bar or Enter to run the same test from the keyboard, and use Reset to run it again.",
    why: "Click speed sites are some of the worst offenders for ads stacked around the click target, which is a real problem when the whole test is about clicking accurately. This one has no ads, no account, and no score leaderboard to farm your data for. Everything is measured and scored in the browser, so your files and inputs never leave your device, and the only thing that can be saved is a single best rate you choose to keep on this device.",
    faq: [
      {
        q: "What is a good clicks per second score?",
        a: "Most people land between 4 and 7 clicks per second with one finger on a 10 second test. Above 8 is fast for normal clicking, and a sustained rate over a longer window is harder than a burst, so a 60 second run usually reads lower than a 5 second one.",
      },
      {
        q: "What are jitter clicking and butterfly clicking?",
        a: "Jitter clicking means tensing your forearm so the finger vibrates on the button, and butterfly clicking means alternating two fingers on the same button. Both push rates into the 10 to 20 range, well past what ordinary clicking reaches. They also put real strain on your hand and wear out mouse switches quickly, so treat those numbers as a separate technique rather than a better score.",
      },
      {
        q: "Does the test store my score?",
        a: "Only if you ask it to. The best rate button saves a single number in this browser as a preference, and the Clear button removes it. Nothing is uploaded, and your test length and input mode are the only things captured in the page link.",
      },
    ],
  },
};
