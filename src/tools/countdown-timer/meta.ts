import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "countdown-timer",
  matrixSlug: "timer",
  icon: "Hourglass",
  name: "Countdown Timer and Stopwatch",
  description: "Shareable-URL countdowns and stopwatches.",
  category: "Time",
  keywords: [
    "online countdown timer",
    "stopwatch online",
    "shareable countdown",
    "countdown to date",
    "timer with alarm",
  ],
  searchTerms: [
    "count up timer",
    "online timer",
    "event countdown",
    "countdown clock",
    "lap timer",
    "split timer",
    "timer with notification",
    "date countdown",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "style",
      label: "Remaining time style",
      default: "clock",
      options: [
        {
          value: "clock",
          label: "Clock (01:02:03)",
          synonyms: ["digits", "numeric", "hh:mm:ss", "clock format"],
        },
        {
          value: "words",
          label: "Words (1 hour 2 minutes 3 seconds)",
          synonyms: ["long", "full", "verbose", "spelled out"],
        },
        {
          value: "compact",
          label: "Compact (1h 2m 3s)",
          synonyms: ["short", "abbreviated", "abbr"],
        },
      ],
    },
  ],
  copy: {
    what: "Runs a countdown to a target date and time or from a plain duration like 1h 30m, and doubles as a stopwatch with lap tracking. Every countdown or stopwatch state is packed into the URL so a pasted link reproduces exactly what you started, down to the second.",
    how: "Type a duration such as 90s or 1h 30m, or a target date and time such as 2026-12-31T23:59 (optionally followed by an IANA zone like America/Chicago), to see when it ends and how much time is left. Use the panel to start, pause, lap, and reset the timer, and to turn on the alarm chime and browser notification.",
    why: "Most countdown sites run ads next to the numbers and lose your timer the moment you close the tab. This one keeps the whole state in the link you already have open, plays the alarm locally in your browser, and never sends the target date, duration, or label to a server.",
    faq: [
      {
        q: "Does the countdown keep running if I close the tab?",
        a: "A countdown to a target date does, since the target date is stored in the share link itself. A duration countdown stores its start time in the link too, so reopening the same link picks up the remaining time correctly.",
      },
      {
        q: "Is my countdown or timer data sent anywhere?",
        a: "No. Parsing, counting down, and the alarm all run in your browser, and your files and inputs never leave your device.",
      },
      {
        q: "What date and duration formats are supported?",
        a: "Durations accept unit shorthand like 5m or 1h 30m, plain numbers read as seconds, and clock forms like 2:30 or 01:30:00. Target dates accept ISO 8601 like 2026-12-31T23:59, optionally followed by an IANA time zone name.",
      },
    ],
  },
};
