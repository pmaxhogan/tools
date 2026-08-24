import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "epoch-converter",
  icon: "Clock",
  matrixSlug: "epoch",
  name: "Epoch Converter",
  description: "Convert unix timestamps to and from human-readable dates in any time zone.",
  category: "Time",
  keywords: ["epoch", "unix timestamp", "timestamp converter", "unix time", "date converter"],
  searchTerms: [
    "unix time converter",
    "timestamp to date",
    "date to timestamp",
    "seconds since epoch",
    "milliseconds timestamp",
    "convert timestamp to human readable",
    "iso 8601 converter",
    "unix epoch calculator",
    "utc converter",
    "epoch time",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "tz",
      label: "Time zone",
      default: "UTC",
      groups: [
        {
          label: "Universal and local",
          synonyms: ["utc", "gmt", "system time zone", "browser time zone", "no time zone"],
          options: [
            { value: "UTC", label: "UTC", synonyms: ["gmt", "coordinated universal time", "zulu"] },
            {
              value: "local",
              label: "Local time",
              synonyms: ["my time zone", "browser time zone", "device time zone"],
            },
          ],
        },
        {
          label: "Americas",
          synonyms: ["north america", "us time zones", "united states", "canada"],
          options: [
            {
              value: "America/New_York",
              label: "America/New_York",
              synonyms: ["eastern time", "est", "edt", "new york"],
            },
            {
              value: "America/Chicago",
              label: "America/Chicago",
              synonyms: ["central time", "cst", "cdt", "chicago"],
            },
            {
              value: "America/Denver",
              label: "America/Denver",
              synonyms: ["mountain time", "mst", "mdt", "denver"],
            },
            {
              value: "America/Los_Angeles",
              label: "America/Los_Angeles",
              synonyms: ["pacific time", "pst", "pdt", "los angeles", "california"],
            },
          ],
        },
        {
          label: "Europe",
          synonyms: ["european time zones", "uk", "united kingdom", "germany"],
          options: [
            {
              value: "Europe/London",
              label: "Europe/London",
              synonyms: ["gmt", "bst", "uk time", "london"],
            },
            {
              value: "Europe/Berlin",
              label: "Europe/Berlin",
              synonyms: ["cet", "cest", "germany", "central european time"],
            },
          ],
        },
        {
          label: "Asia and Pacific",
          synonyms: ["asia pacific", "apac"],
          options: [
            {
              value: "Asia/Tokyo",
              label: "Asia/Tokyo",
              synonyms: ["jst", "japan time", "tokyo"],
            },
            {
              value: "Australia/Sydney",
              label: "Australia/Sydney",
              synonyms: ["aest", "aedt", "australia time", "sydney"],
            },
          ],
        },
      ],
    },
  ],
  examples: [
    {
      label: "Unix timestamp",
      input: "1754521200",
    },
    {
      label: "ISO date in Chicago",
      input: "2026-12-25T09:00:00Z",
      opts: { tz: "America/Chicago" },
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Converts between unix timestamps (seconds or milliseconds) and human-readable dates. Paste a timestamp to see it as ISO 8601, local time, and relative time, or paste a date string to get its unix timestamp. Detects seconds vs milliseconds automatically.",
    how: "Paste a timestamp like 1754521200 or a date like 2026-08-06T21:00:00Z into the input. Pick a time zone to see the conversion there. Every value has its own copy button, and the URL updates so you can share exactly what you see.",
    why: "The popular epoch converter sites bury the answer under ads and cookie banners. This one is instant, works offline, never sends your input anywhere, and has no usage limits.",
    faq: [
      {
        q: "Does it handle milliseconds?",
        a: "Yes. Values of 13+ digits are treated as milliseconds, shorter ones as seconds. Both conversions are always shown.",
      },
      {
        q: "Is my input sent to a server?",
        a: "No. The conversion runs entirely in your browser, and the page works offline after first load.",
      },
      {
        q: "What date formats can I paste?",
        a: "Unix seconds, unix milliseconds, ISO 8601, RFC 2822, and anything else your browser can parse natively.",
      },
    ],
  },
};
