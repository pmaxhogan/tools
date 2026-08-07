import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'week-number',
  matrixSlug: 'iso-week',
  name: 'Week & Day Numbers',
  description: 'ISO week, day-of-year and quarter lookups.',
  category: 'Time',
  keywords: [
    'iso week number',
    'week number calculator',
    'day of year',
    'what week is it',
    'iso 8601 week',
    'quarter calculator',
    'day of week number',
  ],
  searchTerms: [
    'what week of the year',
    'calendar week calculator',
    'iso week date',
    'week of year lookup',
    'day number of year',
    'julian day calculator',
    'fiscal quarter lookup',
    'work week number',
    'current week number',
    'week year calculator',
  ],
  input: 'text/plain',
  output: 'application/json',
  http: { method: 'GET', contentType: 'application/json' },
  copy: {
    what: 'Looks up the ISO 8601 week number, day-of-year, quarter, and weekday for any date. Handles the tricky year-boundary cases correctly: a date near Jan 1 or Dec 31 can belong to a week number from the adjacent calendar year, and this tool gets that right instead of just counting weeks from Jan 1.',
    how: 'Paste a date like 2026-08-06 (or a full ISO datetime) into the input, or leave it empty to use today. You get the ISO week, the ISO week-year, day-of-year, weekday name with its ISO number, quarter, days remaining in the year, and the Monday-Sunday date range of that week.',
    why: "Most week-number calculators get the year boundary wrong: they'll happily tell you Jan 1 is week 1 of its own calendar year even when ISO 8601 says otherwise. This one implements the real ISO 8601 rule (week 1 is the week containing the year's first Thursday), runs entirely on your device, and has no ads or rate limits.",
    faq: [
      {
        q: 'Why does Jan 1 sometimes show a week number from the previous year, like W53?',
        a: "Per ISO 8601, a week belongs to whichever year contains that week's Thursday. If Jan 1 falls on a Friday, Saturday, or Sunday, that week's Thursday is still in December, so the date counts as the last week (W52 or W53) of the previous year.",
      },
      {
        q: 'What date formats are accepted?',
        a: 'ISO 8601 dates like 2026-08-06, or full datetimes like 2026-08-06T21:00:00Z. Only the calendar date is used: time-of-day and offset are ignored so results stay deterministic.',
      },
      {
        q: 'Is the calculation done in my local time zone?',
        a: 'No, everything is computed in UTC. This keeps week and day numbers consistent regardless of where you or your server are located.',
      },
    ],
  },
};
