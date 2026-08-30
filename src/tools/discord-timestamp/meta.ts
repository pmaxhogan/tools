import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "discord-timestamp",
  icon: "Watch",
  matrixSlug: "discord-time",
  name: "Discord Timestamps",
  description:
    "Generate Discord's timestamp tags from a date or unix time, rendered in every reader's own local timezone automatically.",
  category: "Time",
  keywords: [
    "discord timestamp",
    "discord time tag",
    "discord unix timestamp",
    "discord relative time",
    "discord date tag",
    "unix to discord",
  ],
  searchTerms: [
    "discord time tag generator",
    "discord dynamic timestamp",
    "discord countdown timestamp",
    "unix to discord tag",
    "t:unix format",
    "discord relative time tag",
    "discord epoch tag",
    "discord bot timestamp",
    "discord message timestamp",
    "discord snowflake",
    "discord time converter",
  ],
  input: "text/plain",
  output: "application/json",
  examples: [{ label: "Upcoming event date", input: "2026-12-25T18:00:00Z" }],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: 'Generates Discord\'s <t:UNIX:style> timestamp tags from a date or unix timestamp. Paste a time and get all seven display styles at once: short/long time, short/long date, short/long date-time, and relative ("in 2 hours"), each rendered in whatever timezone the reader viewing the message is in.',
    how: "Paste a unix timestamp (seconds or milliseconds), an ISO 8601 date, or leave the input blank to use the current time. Copy whichever tag style you want (short time, long date, relative, etc.) and paste it directly into a Discord message; Discord renders it locally for each reader.",
    why: "Other Discord timestamp generators require picking a date from a calendar widget and run behind ads. This one also accepts a raw unix or ISO timestamp directly, runs entirely in your browser, and never sends your input anywhere.",
    faq: [
      {
        q: "Why does the timestamp look the same for everyone but display differently?",
        a: "The tag <t:UNIX:F> encodes a single unix timestamp; Discord's client renders it into each reader's local timezone and locale at display time, so no timezone math is needed in the message itself.",
      },
      {
        q: "What timestamp format should I paste in?",
        a: "Unix seconds (1754521200), unix milliseconds (1754521200000), or an ISO 8601 date like 2026-08-06T21:00:00Z. Leave the input empty to use the current time.",
      },
      {
        q: "Which style should I use for a relative countdown?",
        a: 'Use the R style: it renders as "in 2 hours" or "3 days ago" and updates live as readers view the message.',
      },
    ],
  },
};
