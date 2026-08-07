import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'duration-calculator',
  matrixSlug: 'duration',
  name: 'Duration Calculator',
  description: 'Add and subtract clock times and durations.',
  category: 'Time',
  keywords: [
    'duration calculator',
    'add time',
    'time calculator',
    'time duration calculator',
    'add subtract time',
    'elapsed time calculator',
    'hours minutes calculator',
    'clock time math',
  ],
  input: 'text/plain',
  output: 'application/json',
  http: { method: 'GET', contentType: 'application/json' },
  copy: {
    what: "Adds and subtracts clock times and durations in a single expression. Mix hh:mm:ss clock times, unit shorthand like 90m, 1.5h, or 2h 30m, and plain numbers (read as minutes), joined with + and -, or paste one duration per line to sum them all. Returns the total as hh:mm:ss, a humanized 'X days Y hours Z minutes' string, and totals in seconds, minutes, and hours.",
    how: 'Type an expression like "1:30:00 + 45min - 20s" or paste a list of durations, one per line, like "90m", "1.5h", "45s". The tool parses every term, evaluates left to right, and shows the running total in five formats at once. Negative totals are shown with a leading minus sign across every field.',
    why: 'Most time-calculator sites make you pick start and end times from dropdowns or fight a stopwatch-style UI. This one just reads what you type (mixed formats, decimals, and line lists all work) and never sends your durations to a server.',
    faq: [
      {
        q: 'What duration formats are supported?',
        a: 'Clock forms like 1:30:00 or 1:30, unit shorthand like 90m, 1.5h, 2h 30m, 1d, 30s, and 500ms, plus bare numbers (treated as minutes). All formats are case-insensitive and tolerate extra spaces.',
      },
      {
        q: 'Can I paste a list of times instead of writing an expression?',
        a: 'Yes, put one duration per line with no + or - operators and every line is summed together into the total.',
      },
      {
        q: 'How are negative totals shown?',
        a: 'If subtraction produces a negative total, every field reflects it: for example Total (hh:mm:ss) reads as -01:15:00 instead of wrapping around to a positive value.',
      },
    ],
  },
};
