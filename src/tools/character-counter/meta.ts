import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'character-counter',
  matrixSlug: 'count',
  name: 'Character Counter',
  description:
    'Grapheme-accurate character, word, sentence, line, byte, and LLM token counts for any text.',
  category: 'Text',
  keywords: [
    'character counter',
    'word counter',
    'token counter',
    'gpt token counter',
    'grapheme counter',
    'utf-8 byte counter',
    'sentence counter',
    'letter count',
  ],
  input: 'text/plain',
  output: 'application/json',
  options: [
    {
      kind: 'select',
      id: 'encoding',
      label: 'Token encoding',
      default: 'o200k_base',
      choices: [
        { value: 'o200k_base', label: 'GPT-4o / GPT-4.1 / o-series' },
        { value: 'cl100k_base', label: 'GPT-3.5 / GPT-4' },
      ],
    },
  ],
  copy: {
    what: 'Counts characters, words, sentences, lines, paragraphs, bytes, and LLM tokens for any pasted text. Characters are counted as grapheme clusters, the way a person actually reads them, along with raw UTF-16 code units, Unicode codepoints, and UTF-8 byte length for cases where those differ.',
    how: 'Paste or type text into the input. Every count updates immediately: characters, characters without spaces, code units, codepoints, words, sentences, lines, paragraphs, UTF-8 bytes, and GPT tokens. Switch the token encoding option to match the model you are budgeting for.',
    why: 'Most character counters only report JavaScript string length, which splits emoji and accented text into the wrong number of characters and cannot tell you the token count a model will actually see. This one counts grapheme clusters correctly and runs the real GPT tokenizer locally, with no ads and no length cap, and your files and inputs never leave your device.',
    faq: [
      {
        q: 'Why does an emoji count as one character here but more elsewhere?',
        a: 'This tool counts grapheme clusters (what a person sees as one character) using Intl.Segmenter, so a family emoji or a flag built from multiple codepoints counts as one character. Tools that use plain string length count each underlying UTF-16 code unit instead, which can report five or more for a single emoji.',
      },
      {
        q: 'What is a token, and why is the count different from the word count?',
        a: 'A token is the unit an LLM actually processes, roughly three to four characters of English text on average, and it rarely lines up with word boundaries. The token count here uses the real GPT tokenizer (o200k_base or cl100k_base, matching the model you pick) so it matches what the model bills and limits, not an approximation.',
      },
      {
        q: 'Does my text get uploaded anywhere?',
        a: 'No. Every count, including the token count, is computed locally in your browser, and your files and inputs never leave your device.',
      },
    ],
  },
};
