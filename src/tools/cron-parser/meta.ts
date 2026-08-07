import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'cron-parser',
  matrixSlug: 'cron',
  name: 'Cron Parser',
  description: 'Build expressions, read them in English, preview the next ten runs.',
  category: 'Time',
  keywords: [
    'cron',
    'cron expression',
    'crontab',
    'cron parser',
    'cron to english',
    'cron schedule',
    'next run times',
    'cron expression generator',
  ],
  input: 'text/plain',
  output: 'application/json',
  options: [
    {
      kind: 'text',
      id: 'tz',
      label: 'Time zone',
      default: 'UTC',
      placeholder: 'UTC, America/Chicago, Europe/Berlin…',
    },
    { kind: 'boolean', id: 'seconds', label: 'Expression includes seconds', default: false },
  ],
  http: { method: 'GET', contentType: 'application/json' },
  copy: {
    what: 'Translates a cron expression into a plain-English sentence and shows the next ten times it will actually fire. Handles the standard five-field crontab syntax plus six-field expressions with a leading seconds column, including step values, ranges, lists, and named days and months. The run preview is computed in whichever IANA time zone you pick, so daylight-saving shifts show up in the answer instead of surprising you in production.',
    how: "Paste an expression like */15 9-17 * * 1-5 into the input. Set the time zone field to the zone your scheduler runs in — UTC, America/Chicago, Europe/Berlin, anything IANA — and flip the seconds toggle on if your expression starts with a seconds column (Quartz, Spring, and node-cron style). The English reading appears first, followed by ten upcoming fire times as ISO 8601 timestamps with that zone's offset, each with its own copy button.",
    why: 'The popular cron sites wrap the answer in ad slots, gate the run preview behind a signup, or silently assume UTC and let you deploy a job that fires at the wrong hour. This one parses in your browser, so the expression never leaves your device, works offline after first load, has no run limits, and states the time zone in every timestamp it prints.',
    faq: [
      {
        q: 'Does it support six-field expressions with seconds?',
        a: 'Yes. Turn on the "Expression includes seconds" toggle and the first field is read as seconds, so 30 0 9 * * 1-5 becomes "At 09:00:30 AM, Monday through Friday". Leave it off for classic five-field crontab lines — a mismatched field count gives you an explicit error rather than a wrong schedule.',
      },
      {
        q: 'Why do some previewed times jump by an hour?',
        a: 'Because they cross a daylight-saving boundary in the zone you selected. Cron fires on local wall-clock time, so a 2 AM daily job in America/New_York moves from -05:00 to -04:00 in March. Each timestamp prints its UTC offset so the jump is visible.',
      },
      {
        q: 'Is my expression sent to a server?',
        a: 'No. Parsing and the run preview happen entirely in your browser; the page makes no network requests with your input.',
      },
    ],
  },
};
