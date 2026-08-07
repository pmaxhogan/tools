import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'invisible-character-detector',
  icon: 'Ghost',
  matrixSlug: 'invisibles',
  name: 'Invisible Characters',
  description:
    'Reveal zero-width characters, BOMs, non-breaking spaces, bidi controls, and stray line endings in pasted text.',
  category: 'Text',
  keywords: [
    'zero width space detector',
    'invisible character checker',
    'remove invisible characters',
    'unicode whitespace detector',
    'bom remover',
    'hidden character finder',
    'zero width character remover',
    'bidi control character detector',
  ],
  searchTerms: [
    'hidden unicode checker',
    'zero width joiner',
    'chatgpt watermark detector',
    'ai text watermark',
    'unicode steganography',
    'find hidden characters',
    'strange characters in text',
    'trailing whitespace finder',
    'string comparison fails',
    'copy paste weird characters',
  ],
  input: 'text/plain',
  output: 'text/plain',
  options: [
    {
      kind: 'select',
      id: 'mode',
      label: 'Mode',
      default: 'annotate',
      choices: [
        { value: 'annotate', label: 'Annotate (show tags inline)' },
        { value: 'strip', label: 'Strip (clean the text)' },
        { value: 'report', label: 'Report (list positions)' },
      ],
    },
    {
      kind: 'boolean',
      id: 'keepNewlines',
      label: 'Keep line breaks when stripping',
      default: true,
    },
  ],
  http: { method: 'GET', contentType: 'text/plain' },
  copy: {
    what: 'Scans pasted text for characters that render as nothing: zero-width spaces and joiners, byte-order marks, non-breaking and exotic Unicode spaces, bidi (left-to-right/right-to-left) control characters, soft hyphens, variation selectors, and mixed or stray line endings. It flags every occurrence with an exact line and column, not just a yes-or-no answer.',
    how: 'Paste text into the input and pick a mode. Annotate replaces each invisible character with a visible bracketed tag like ⟦ZWSP⟧ right where it sits in the text. Report lists every finding with its line, column, codepoint, and a count summary. Strip removes invisible characters, normalizes non-breaking spaces to a plain space, and optionally folds CRLF or lone CR line endings down to LF.',
    why: 'Most invisible character checkers online only catch a couple of zero-width codepoints and miss bidi controls, exotic Unicode spaces, and mixed line endings, all common causes of strings that look identical but fail equality checks or break downstream parsers. This one covers the full set and shows exactly where each one sits, and your files and inputs never leave your device.',
    faq: [
      {
        q: 'Why does my string fail a comparison even though it looks identical?',
        a: 'A copied string often carries an invisible character, such as a zero-width space, a non-breaking space that looks like a normal space, or a byte-order mark at the start of a file. Two strings can look the same on screen while differing in these hidden codepoints, so equality checks and hashes fail. Run the text through report mode to see exactly which character and position is different.',
      },
      {
        q: 'What is a zero-width space and why would it be in my text?',
        a: 'A zero-width space (U+200B) is a Unicode character that takes up no visible width but still counts as a character. It commonly gets inserted by word processors for line-break hints, by some CMS or translation tools, or when copying text from PDFs and web pages that use it to control word wrapping.',
      },
      {
        q: 'How do invisible characters end up in my text in the first place?',
        a: 'Common sources are copy-pasting from web pages, PDFs, or word processors that insert soft hyphens and zero-width joiners, saving a file with a UTF-8 byte-order mark, mixing bidi control characters when composing right-to-left and left-to-right text together, and mixing line endings when merging files created on different operating systems.',
      },
    ],
  },
};
