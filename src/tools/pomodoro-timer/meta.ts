import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "pomodoro-timer",
  matrixSlug: "pomodoro",
  icon: "Clock3",
  name: "Pomodoro Timer",
  description:
    "Run a Pomodoro work and break schedule as a live, always on top pop-out timer with configurable session counts.",
  category: "Time",
  keywords: [
    "pomodoro timer online",
    "pomodoro technique timer",
    "25 5 timer",
    "focus timer",
    "pop out pomodoro",
    "tomato timer",
  ],
  searchTerms: [
    "work break timer",
    "study timer",
    "focus session timer",
    "pomodoro technique",
    "always on top timer",
    "picture in picture timer",
    "productivity timer",
    "deep work timer",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    { kind: "number", id: "work", label: "Work minutes", default: 25, min: 1, max: 120 },
    { kind: "number", id: "shortBreak", label: "Short break minutes", default: 5, min: 1, max: 60 },
    { kind: "number", id: "longBreak", label: "Long break minutes", default: 15, min: 1, max: 60 },
    {
      kind: "number",
      id: "cyclesBeforeLong",
      label: "Work sessions before a long break",
      default: 4,
      min: 1,
      max: 10,
    },
    { kind: "number", id: "sessions", label: "Total work sessions", default: 8, min: 1, max: 16 },
    {
      kind: "boolean",
      id: "autoStartBreaks",
      label: "Auto start breaks",
      default: true,
    },
  ],
  copy: {
    what: "Builds a Pomodoro work and break schedule, then runs it as a live, always on top pop-out timer. Set your work length, short break, long break, how many sessions run before a long break, and the total number of sessions, or paste a shorthand like 25/5 or 50/10/30x3. The pop-out window keeps counting down accurately even when this tab is in the background, and it chimes when a phase ends.",
    how: "Type a shorthand like 25/5 or adjust the number options, then open the pop-out button above the timer to float it in its own always on top window. Start, pause, skip, or reset from either the main page or the pop-out, since both read and write the same timer state in the page URL, so pasting that link on another screen resumes the exact same countdown.",
    why: "Most Pomodoro timer sites need their own browser tab pinned in front of everything else, come with ads, or lose the countdown the moment the tab is backgrounded. This one uses real timestamps instead of a fragile interval, so it stays accurate no matter what else the tab is doing, and it pops out into a genuine always on top window without an extension. Your inputs never leave your device.",
    faq: [
      {
        q: "Does it keep time correctly when the tab is in the background or minimized?",
        a: "Yes. The countdown is computed from the start timestamp and the current time, not from a repeating interval, so backgrounding or minimizing the tab never lets it drift or freeze.",
      },
      {
        q: "Can I keep the timer visible while I work in another app?",
        a: "Yes. Use the pop-out button on this page to float the timer in a small always on top window using your browser's Picture in Picture support, separate from the main browser window.",
      },
      {
        q: "Is my schedule or progress synced online anywhere?",
        a: "No. The timer state lives only in this page's URL and your browser, never on a server, so nothing about your work sessions is tracked or synced.",
      },
    ],
  },
};
