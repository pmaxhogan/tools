import type { ToolLogic } from '../types';

export interface CountOpts {
  /** gpt-tokenizer encoding to use for the token count. */
  encoding: 'o200k_base' | 'cl100k_base';
  [key: string]: unknown;
}

export type CountResult = Record<string, string>;

const ZERO_RESULT: CountResult = {
  Characters: '0',
  'Characters (no spaces)': '0',
  'UTF-16 code units': '0',
  'Unicode codepoints': '0',
  Words: '0',
  Sentences: '0',
  Lines: '0',
  Paragraphs: '0',
  'UTF-8 bytes': '0',
  'GPT tokens': '0',
};

function countGraphemes(text: string): { total: number; nonSpace: number } {
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  let total = 0;
  let nonSpace = 0;
  for (const { segment } of segmenter.segment(text)) {
    total++;
    if (!/\s/.test(segment)) nonSpace++;
  }
  return { total, nonSpace };
}

function countWords(text: string): number {
  const segmenter = new Intl.Segmenter('en', { granularity: 'word' });
  let words = 0;
  for (const { isWordLike } of segmenter.segment(text)) {
    if (isWordLike) words++;
  }
  return words;
}

function countSentences(text: string): number {
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  let sentences = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (segment.trim() !== '') sentences++;
  }
  return sentences;
}

function countLines(text: string): number {
  if (text === '') return 0;
  return text.split(/\r?\n/).length;
}

function countParagraphs(text: string): number {
  return text
    .split(/\r?\n\s*\r?\n+/)
    .map((p) => p.trim())
    .filter((p) => p !== '').length;
}

async function countTokens(text: string, encoding: CountOpts['encoding']): Promise<number> {
  if (encoding === 'cl100k_base') {
    const { countTokens: count } = await import('gpt-tokenizer/encoding/cl100k_base');
    return count(text);
  }
  const { countTokens: count } = await import('gpt-tokenizer/encoding/o200k_base');
  return count(text);
}

export async function run(input: string, opts: CountOpts): Promise<CountResult> {
  const text = input ?? '';
  if (text === '') return { ...ZERO_RESULT };

  const { total: characters, nonSpace: charactersNoSpaces } = countGraphemes(text);
  const encoding = opts.encoding === 'cl100k_base' ? 'cl100k_base' : 'o200k_base';
  const tokens = await countTokens(text, encoding);

  return {
    Characters: String(characters),
    'Characters (no spaces)': String(charactersNoSpaces),
    'UTF-16 code units': String(text.length),
    'Unicode codepoints': String(Array.from(text).length),
    Words: String(countWords(text)),
    Sentences: String(countSentences(text)),
    Lines: String(countLines(text)),
    Paragraphs: String(countParagraphs(text)),
    'UTF-8 bytes': String(new TextEncoder().encode(text).length),
    'GPT tokens': String(tokens),
  };
}

export default { run } satisfies ToolLogic<string, CountResult, CountOpts>;
