import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'escape-unescape',
  matrixSlug: 'escape',
  name: 'Escape / Unescape',
  description: 'JSON, HTML entity, regex, shell and URL escaping.',
  category: 'Text',
  keywords: [
    'escape string',
    'unescape string',
    'json escape',
    'html entities',
    'url encode decode',
    'regex escape',
    'shell quote escape',
  ],
  input: 'text/plain',
  output: 'text/plain',
  options: [
    {
      kind: 'select',
      id: 'format',
      label: 'Format',
      default: 'json',
      choices: [
        { value: 'json', label: 'JSON string' },
        { value: 'html', label: 'HTML entities' },
        { value: 'url', label: 'URL / percent-encoding' },
        { value: 'regex', label: 'Regex metacharacters' },
        { value: 'shell', label: 'Shell (POSIX single-quote)' },
      ],
    },
    {
      kind: 'select',
      id: 'direction',
      label: 'Direction',
      default: 'escape',
      choices: [
        { value: 'escape', label: 'Escape' },
        { value: 'unescape', label: 'Unescape' },
      ],
    },
  ],
  http: { method: 'POST', contentType: 'text/plain' },
  copy: {
    what: 'Escapes or unescapes text for five common formats: JSON string literals, HTML entities, URL percent-encoding, regex metacharacters, and POSIX shell single-quoting. Handles the full round trip, including named, decimal, and hex HTML entities decoded without touching the DOM.',
    how: 'Paste your text, pick a format, and choose Escape or Unescape. The result updates instantly and has its own copy button. Malformed input for JSON or URL unescaping raises a specific error instead of silently returning garbage.',
    why: 'Most escaping tools online only handle one format and quietly mangle malformed input instead of telling you what is wrong. This one covers five formats in one place, runs entirely in your browser, and never sends your text anywhere.',
    faq: [
      {
        q: 'Does the HTML entity decoder use the browser DOM?',
        a: 'No. It uses a hand-rolled map of common named entities plus decimal (&#233;) and hex (&#xE9;) numeric entities, so it works the same in Node and in any browser.',
      },
      {
        q: 'What happens if I unescape invalid JSON or URL text?',
        a: 'You get a clear error explaining what is wrong — for example an unescaped quote in JSON or a stray % without two hex digits in a URL — instead of a mangled result.',
      },
      {
        q: 'How does shell escaping work?',
        a: 'It wraps your text in single quotes and replaces any single quote inside it with the standard POSIX \'\\\'\' sequence, so the result is safe to paste into a shell command as one literal argument.',
      },
    ],
  },
};
