import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "temporal-playground",
  matrixSlug: "temporal",
  name: "Temporal Playground",
  description:
    "Explore date math, time zones, and DST edge cases with the Temporal API in your browser.",
  category: "Time",
  icon: "CalendarClock",
  keywords: [
    "temporal api playground",
    "date math",
    "dst calculator",
    "timezone date math",
    "spring forward gap",
    "iso 8601 date tool",
  ],
  searchTerms: [
    "temporal js",
    "plaindatetime",
    "zoneddatetime",
    "daylight saving time test",
    "add duration to date",
    "iso week number",
    "day of year calculator",
    "leap year check",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "timeZone",
      label: "Time zone",
      default: "UTC",
      groups: [
        {
          label: "Universal",
          synonyms: ["utc", "gmt", "no offset", "zulu"],
          options: [
            {
              value: "UTC",
              label: "UTC",
              synonyms: ["gmt", "coordinated universal time", "zulu", "+00:00"],
            },
          ],
        },
        {
          label: "Americas",
          synonyms: ["north america", "united states", "us time zones", "canada"],
          options: [
            {
              value: "America/New_York",
              label: "America/New_York",
              synonyms: ["eastern time", "est", "edt", "new york", "-05:00", "-04:00"],
            },
            {
              value: "America/Chicago",
              label: "America/Chicago",
              synonyms: ["central time", "cst", "cdt", "chicago", "-06:00", "-05:00"],
            },
            {
              value: "America/Denver",
              label: "America/Denver",
              synonyms: ["mountain time", "mst", "mdt", "denver", "-07:00", "-06:00"],
            },
            {
              value: "America/Los_Angeles",
              label: "America/Los_Angeles",
              synonyms: [
                "pacific time",
                "pst",
                "pdt",
                "los angeles",
                "california",
                "-08:00",
                "-07:00",
              ],
            },
          ],
        },
        {
          label: "Europe",
          synonyms: ["european time zones", "eu", "uk", "france", "germany"],
          options: [
            {
              value: "Europe/London",
              label: "Europe/London",
              synonyms: ["uk time", "gmt", "bst", "london", "britain", "+00:00", "+01:00"],
            },
            {
              value: "Europe/Paris",
              label: "Europe/Paris",
              synonyms: ["cet", "cest", "france", "paris", "+01:00", "+02:00"],
            },
            {
              value: "Europe/Berlin",
              label: "Europe/Berlin",
              synonyms: [
                "cet",
                "cest",
                "germany",
                "berlin",
                "central european time",
                "+01:00",
                "+02:00",
              ],
            },
          ],
        },
        {
          label: "Asia and Pacific",
          synonyms: ["asia pacific", "apac", "oceania"],
          options: [
            {
              value: "Asia/Kolkata",
              label: "Asia/Kolkata",
              synonyms: ["ist", "india", "kolkata", "calcutta", "half hour offset", "+05:30"],
            },
            {
              value: "Asia/Tokyo",
              label: "Asia/Tokyo",
              synonyms: ["jst", "japan", "tokyo", "no dst", "+09:00"],
            },
            {
              value: "Australia/Sydney",
              label: "Australia/Sydney",
              synonyms: [
                "aest",
                "aedt",
                "australia",
                "sydney",
                "southern hemisphere dst",
                "+10:00",
                "+11:00",
              ],
            },
            {
              value: "Pacific/Auckland",
              label: "Pacific/Auckland",
              synonyms: ["nzst", "nzdt", "new zealand", "auckland", "+12:00", "+13:00"],
            },
          ],
        },
      ],
    },
    {
      kind: "text",
      id: "add",
      label: "Add duration (ISO 8601, e.g. P1M2DT3H)",
      default: "",
      placeholder: "P1D",
    },
  ],
  copy: {
    what: "Runs a date or date-time through the Temporal API and shows what it actually means: the Temporal type it parsed into, the exact instant, epoch seconds and milliseconds, the UTC offset, and whether that offset is standard time or daylight saving time. It flags the two DST traps directly, a spring-forward wall-clock time that never happens and a fall-back time that happens twice, and it names the next offset change in the zone. Add an ISO 8601 duration to see calendar-aware math, including the offset the result lands on. Calendar facts come along too: day of week, day of year, ISO week, days in month, and leap year.",
    how: 'Paste an ISO 8601 value: a date like 2026-03-08, a wall-clock time like 2026-03-08T01:30, an instant like 2026-03-08T12:00:00Z, or a fully zoned string like 2026-03-07T12:00[America/New_York]. Pick the time zone that a bare wall-clock time should be read in. To do date math, type a duration such as P1D, PT90M, or P1M2DT3H in the "Add duration" field. Every row has its own copy button, and the URL updates so you can share the exact case you are looking at.',
    why: "This is a curated evaluator, not a code sandbox, so there is nothing to install and nothing to run. Your inputs never leave your device, there is no sign-in, no rate limit, and no ad reading over your shoulder while you debug a scheduling bug. Compared with poking at JavaScript Date in a console, you get the DST answer stated in words rather than inferred from a suspicious offset, and compared with the docs playgrounds you get a permanent URL for the exact edge case you want to send to a teammate.",
    faq: [
      {
        q: "What is Temporal?",
        a: "Temporal is the modern date and time API for JavaScript, built to replace Date. It separates the concepts Date blurs together: a PlainDate has no time, a PlainDateTime is a wall-clock reading with no zone, an Instant is a fixed point on the timeline, and a ZonedDateTime is a wall-clock reading anchored to an IANA time zone. That separation is why it can answer DST questions honestly instead of guessing.",
      },
      {
        q: "Why does adding a day change the time?",
        a: "It does not change the wall-clock time, it changes the offset. Adding P1D to 2026-03-07T12:00 in America/New_York gives 2026-03-08T12:00, still noon, but the zone moved from -05:00 to -04:00 at 2:00 that morning, so only 23 real hours passed. If you wanted exactly 24 hours, add PT24H instead. This tool prints both the new wall time and the new offset so the difference is visible.",
      },
      {
        q: "Is Temporal in browsers yet?",
        a: "Support is arriving but is not universal, so this page runs the official Temporal polyfill locally in your browser. The results match the specified behavior, including the IANA time zone data your device already ships, and nothing is sent to a server to compute them.",
      },
    ],
  },
};
