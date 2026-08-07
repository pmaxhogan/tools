import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'case-converter',
  matrixSlug: 'case',
  name: 'Case Converter',
  description: 'camelCase, snake_case, kebab-case, Title Case and URL slugs.',
  category: 'Text',
  keywords: [
    'case converter',
    'camel case converter',
    'snake case converter',
    'kebab case converter',
    'title case converter',
    'text to slug',
    'url slug generator',
    'string case converter',
  ],
  input: 'text/plain',
  output: 'application/json',
  http: { method: 'GET', contentType: 'application/json' },
  copy: {
    what: 'Converts text into every common naming case at once: camelCase, PascalCase, snake_case, SCREAMING_SNAKE_CASE, kebab-case, Title Case, Sentence case, lowercase, UPPERCASE, and a URL-safe slug. It tokenizes robustly — splitting on spaces, underscores, hyphens, and camelCase boundaries, including acronym runs like "parseHTMLDocument" or "XMLHttpRequest" — so mixed-format input still converts cleanly.',
    how: 'Paste or type any text, identifier, or phrase. Multi-line input is supported — each line converts independently and the results stay lined up. Every result row has its own copy button, so you can grab exactly the case you need.',
    why: 'Most case converters online handle one format at a time, mangle acronyms, or leave diacritics in your slugs. This one produces all ten formats in a single pass, folds accented characters (é → e) for clean URL slugs, and applies real Title Case small-word rules — all client-side, with no ads or usage limits.',
    faq: [
      {
        q: 'How does it handle acronyms like HTML or XML in camelCase input?',
        a: 'It detects acronym runs as a single unit and splits them from the surrounding words, so "parseHTMLDocument" tokenizes to parse / HTML / Document rather than parse / H / T / M / L / Document.',
      },
      {
        q: 'What happens to accented characters in the URL slug?',
        a: 'The URL slug folds diacritics to their closest ASCII letter (é becomes e, ñ becomes n, and so on), then strips remaining punctuation and joins words with hyphens.',
      },
      {
        q: 'Does Title Case capitalize every word?',
        a: 'No. Small words like "a", "the", "of", "in", and "and" stay lowercase unless they are the first or last word, matching standard title-case style rules.',
      },
    ],
  },
};
