import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "reaction-time-test",
  icon: "Zap",
  name: "Reaction Time Test",
  description:
    "Measure visual reaction time across repeated trials, with false start detection and a comparison against typical human reaction.",
  category: "Testers",
  keywords: [
    "reaction time test",
    "reflex test",
    "visual reaction time",
    "how fast are your reflexes",
    "reaction time checker",
    "average reaction time test",
  ],
  searchTerms: [
    "human benchmark",
    "reflex tester",
    "reaction speed test",
    "click reaction test",
    "spacebar reaction test",
    "reaction time in milliseconds",
    "false start test",
    "aim trainer reflex",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "rounds",
      label: "Rounds",
      default: "5",
      ui: "segmented",
      options: [
        { value: "3", label: "3", synonyms: ["three rounds", "short", "quick"] },
        { value: "5", label: "5", synonyms: ["five rounds", "standard", "default"] },
        { value: "10", label: "10", synonyms: ["ten rounds", "long", "full test"] },
      ],
    },
  ],
  copy: {
    what: "Measures how quickly you react to a visual cue, across a set of 3, 5, or 10 trials. Each trial waits a random 2 to 5 seconds before the target turns, so the timing cannot be predicted, and a press before the target turns is caught and reported as a false start instead of counted as a reaction. After the last round it reports the average, best, worst, median, and standard deviation of your times, alongside a comparison to the 200 to 250 millisecond range most published studies put a simple visual reaction in.",
    how: "Press the target, or press Space or Enter, to arm a round. Wait for it to turn, then react as fast as you can with a click, tap, or the same key. Reacting early ends the round as a false start and the next round starts fresh. Repeat for the chosen number of rounds and the results appear underneath, ready to copy. You can also paste a list of reaction times in milliseconds directly into the box above to get the same statistics without running the live test.",
    why: "Most reaction time sites time the visual cue itself with setTimeout drift baked in, run a fixed three trials with no way to see the spread, and quietly drop false starts instead of reporting them. This test measures the cue and the press on the same clock, reports every trial including false starts, and runs entirely in your browser, so your files and inputs never leave your device. No account, no leaderboard, no ads next to the target you are trying to react to.",
    faq: [
      {
        q: "What is a good reaction time?",
        a: "Most alert adults land between 200 and 250 milliseconds on a simple visual reaction test like this one. Under 150 milliseconds is unusual enough that it is more likely an anticipated press than a true reaction, and over 300 milliseconds usually points to display latency, input latency, or tiredness rather than slow reflexes.",
      },
      {
        q: "Why did my press not count?",
        a: "A press before the target turns is a false start: it means the timing was guessed rather than reacted to, so it is reported separately instead of being averaged into your reaction times. The round then restarts with a fresh random wait.",
      },
      {
        q: "Why does the test wait a random amount of time before each round?",
        a: "A fixed wait lets you learn the rhythm and anticipate the cue instead of reacting to it, which would make every reading a false start in disguise. Drawing each wait from 2 to 5 seconds keeps every round unpredictable.",
      },
    ],
  },
};
