import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "timezone-planner",
  matrixSlug: "timezones",
  icon: "Clock3",
  name: "Timezone Planner",
  description: "Find the overlapping working hours across two to eight cities on any date.",
  category: "Time",
  keywords: [
    "timezone planner",
    "meeting time across time zones",
    "working hours overlap",
    "time zone converter for teams",
    "world clock planner",
    "best time to meet",
    "time zone overlap calculator",
  ],
  searchTerms: [
    "timezone overlap",
    "what time is it in",
    "schedule a call across time zones",
    "distributed team meeting time",
    "time zone difference between cities",
    "utc offset for a date",
    "daylight saving meeting planner",
    "world clock for meetings",
    "remote team meeting time",
    "find a meeting time across timezones",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "number",
      id: "dayStart",
      label: "Working day starts (local hour)",
      default: 9,
      min: 0,
      max: 23,
      step: 1,
    },
    {
      kind: "number",
      id: "dayEnd",
      label: "Working day ends (local hour)",
      default: 17,
      min: 1,
      max: 24,
      step: 1,
    },
  ],
  examples: [
    {
      label: "Transatlantic standup time",
      input: "Europe/Berlin, New York",
      opts: { dayStart: "9", dayEnd: "17" },
    },
  ],
  copy: {
    what: "Takes two to eight places and finds the hours everyone is at their desk at the same time. Each place can be an IANA zone like Europe/Berlin, a city or nickname like nyc, sf, or st louis, or a plain offset like UTC+5:30. The result shows every place's current local time, its UTC offset on the date you are planning, its working window in UTC, and the shared overlap written out in each place's own clock. When there is no overlap it tells you how far apart the windows are and how much one side would have to shift.",
    how: "List the places one per line or separated by commas, for example: Europe/Berlin, st louis, tokyo. To plan a different day, put the date on the first line as 'on 2026-08-18'; otherwise the planner uses today. Use the two hour options to set the working day, such as 8 to 18 or 10 to 16, and they apply to every place at once.",
    why: "The usual meeting planner sites wrap a small grid in ads, cookie walls, and a signup nudge, and a planner that applies today's daylight saving offset to a date months away will quietly be an hour off. This one computes each offset for the exact date you are planning, understands half hour zones like India, handles windows that land on the previous or next calendar day, and runs entirely in your browser, so your inputs never leave your device.",
    faq: [
      {
        q: "Does it handle daylight saving time on the date I pick?",
        a: "Yes. Every offset is computed for the instant being planned, not for today, so a meeting set for July gets July's offsets and one set for January gets January's. Transition days work too: a 9am start in Chicago on the day the clocks spring forward is correctly treated as UTC-5.",
      },
      {
        q: "Can I type city names instead of IANA zones?",
        a: "Yes. Around 150 major cities plus common nicknames are built in, so nyc, sf, la, st louis, sao paulo, delhi, and kl all resolve. Case, punctuation, and accents are ignored. Anything the list does not know is reported by name so you can swap in an IANA zone like Europe/Berlin.",
      },
      {
        q: "What happens when the working hours do not overlap at all?",
        a: "You get the near miss instead of a blank answer: how far apart the closest two windows are, and how much earlier one side would have to start, or how much later the other would have to finish, to share a full hour.",
      },
    ],
  },
};
