import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'unicode-picker',
  matrixSlug: 'unicode',
  name: 'Unicode Picker',
  description: 'Search and copy symbols, arrows, maths and HTML entities.',
  category: 'Text',
  keywords: [
    'unicode character search',
    'symbol picker',
    'html entity lookup',
    'arrow symbols copy paste',
    'math symbols',
    'greek letters copy paste',
    'em dash character',
    'zero width space',
  ],
  input: 'text/plain',
  output: 'application/json',
  options: [
    {
      kind: 'select',
      id: 'category',
      label: 'Category',
      default: 'all',
      // Kept in sync with CATEGORIES in ./data.ts by a test — meta stays
      // dependency-free because the registry imports it eagerly.
      choices: [
        { value: 'all', label: 'All categories' },
        { value: 'arrows', label: 'Arrows' },
        { value: 'math', label: 'Maths & logic' },
        { value: 'greek', label: 'Greek letters' },
        { value: 'currency', label: 'Currency' },
        { value: 'punctuation', label: 'Punctuation & dashes' },
        { value: 'box', label: 'Box drawing' },
        { value: 'superscript', label: 'Superscript & subscript' },
        { value: 'symbols', label: 'Checks, stars & bullets' },
        { value: 'legal', label: 'Legal & editorial' },
        { value: 'invisible', label: 'Invisible characters' },
      ],
    },
  ],
  http: { method: 'GET', contentType: 'application/json' },
  copy: {
    what: 'Searches a curated set of 445 genuinely useful Unicode characters — arrows, maths and logic operators, Greek letters, currency signs, dashes and smart quotes, box-drawing pieces, superscripts and subscripts, checkmarks, stars and bullets, legal marks, and the invisible characters (no-break space, zero width space, zero width joiner). Every result shows the character, its official Unicode name, its code point, and the HTML entity you can paste into markup. Names and code points come straight from the Unicode Character Database, and the legacy HTML 4 entity name is preferred where one exists.',
    how: 'Type what you are looking for — "left arrow", "em dash", "greek", "rupee" — and matches appear as you type; multi-word queries match all the words, so "left arrow" finds "leftwards arrow". Narrow the list with the category filter, or leave the search empty to browse a whole category. Copy the character with the row button, or copy the HTML entity from the label when you need markup. You can also paste a character in to identify it.',
    why: 'The usual symbol sites bury a handful of glyphs under ad slots, autoplaying videos, and a newsletter modal, and most of them cannot tell you the HTML entity at all. This one is a single search box over a hand-picked set, works offline once loaded, and your query never leaves your device. Invisible characters are listed by name with a visible label instead of an empty box you cannot tell apart.',
    faq: [
      {
        q: 'Where do the names and HTML entities come from?',
        a: 'Names and code points are generated from the official Unicode Character Database, so "→" really is U+2192 RIGHTWARDS ARROW. Entities prefer the familiar HTML 4 name (&rarr;, &mdash;, &copy;); characters without one fall back to a numeric reference like &#x2082;, which every browser understands.',
      },
      {
        q: 'How do I find invisible characters like a zero width space?',
        a: 'Search "space", "zero width" or "invisible", or pick the Invisible characters category. Each one is listed by name — no-break space, zero width space, zero width joiner, soft hyphen, word joiner — so you can copy the right one instead of guessing.',
      },
      {
        q: 'Why does it not have every Unicode character?',
        a: 'A full 150,000-character dump is unsearchable and mostly glyphs you will never paste. This is a curated 445 — the symbols people actually reach for — so the first screen of results is usually the one you wanted. Paste any character in to see its name and code point even if you found it elsewhere.',
      },
    ],
  },
};
