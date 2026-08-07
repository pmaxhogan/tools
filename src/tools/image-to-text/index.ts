/**
 * OCR post-processing.
 *
 * Tesseract itself cannot run here. It is a WebAssembly worker that fetches a
 * core and a language pack, and rule 27 keeps this layer free of workers, DOM,
 * and network access. So the split is: `OcrPanel.vue` owns the engine and hands
 * this module the recognition result, and everything that turns that result
 * into something a person can read lives here, pure and tested.
 *
 * The shapes below mirror `tesseract.js`'s `Page` (see its `src/index.d.ts`):
 * a page holds blocks, a block holds paragraphs, a paragraph holds lines, and a
 * line holds words. Every level carries `text`, `confidence` (0 to 100) and a
 * `bbox` in image pixels. They are redeclared rather than imported so this file
 * has no dependency on the OCR package at all.
 */
import { ToolError, type ToolLogic } from '../types';

/* ------------------------------------------------------------------ */
/* result shapes                                                       */
/* ------------------------------------------------------------------ */

/** Pixel rectangle, origin at the top left of the image. */
export interface OcrBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord {
  text: string;
  /** Tesseract reports confidence as a percentage from 0 to 100. */
  confidence: number;
  bbox: OcrBbox;
}

export interface OcrLine {
  text: string;
  confidence: number;
  bbox: OcrBbox;
  words: OcrWord[];
}

export interface OcrParagraph {
  text: string;
  confidence: number;
  bbox: OcrBbox;
  lines: OcrLine[];
}

export interface OcrBlock {
  text: string;
  confidence: number;
  bbox: OcrBbox;
  paragraphs: OcrParagraph[];
}

/** The subset of tesseract.js's `Page` this module reads. */
export interface OcrPage {
  text: string;
  confidence?: number;
  /** Null when the caller did not ask for the `blocks` output format. */
  blocks: OcrBlock[] | null;
}

export interface OcrOpts {
  /** Traineddata code: eng, spa, fra, deu, or jpn. */
  language: string;
  /** text, blocks, or tsv. */
  format: string;
  /** Rebuild indentation and column positions from word bounding boxes. */
  preserveLayout: boolean;
  [key: string]: unknown;
}

/** Below this percentage a word is worth re-reading before you trust it. */
export const LOW_CONFIDENCE = 60;

/** Staged language packs. Sizes are the compressed bytes actually served. */
export const LANGUAGES: Record<string, { name: string; megabytes: number }> = {
  eng: { name: 'English', megabytes: 2.8 },
  spa: { name: 'Spanish', megabytes: 2.0 },
  fra: { name: 'French', megabytes: 0.7 },
  deu: { name: 'German', megabytes: 1.3 },
  jpn: { name: 'Japanese', megabytes: 1.9 },
};

export const FORMATS: Record<string, string> = {
  text: 'Plain text',
  blocks: 'Blocks with confidence',
  tsv: 'TSV with positions',
};

/* ------------------------------------------------------------------ */
/* small numeric helpers                                               */
/* ------------------------------------------------------------------ */

function median(values: number[]): number {
  const usable = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (usable.length === 0) return 0;
  const mid = Math.floor(usable.length / 2);
  return usable.length % 2 === 1 ? usable[mid]! : (usable[mid - 1]! + usable[mid]!) / 2;
}

function bboxWidth(bbox: OcrBbox | undefined): number {
  if (!bbox) return 0;
  return Math.max(0, bbox.x1 - bbox.x0);
}

function bboxHeight(bbox: OcrBbox | undefined): number {
  if (!bbox) return 0;
  return Math.max(0, bbox.y1 - bbox.y0);
}

/* ------------------------------------------------------------------ */
/* flattening                                                          */
/* ------------------------------------------------------------------ */

/** Every line in the page, in tesseract's reading order. */
export function collectLines(page: OcrPage | null | undefined): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const block of page?.blocks ?? []) {
    for (const paragraph of block?.paragraphs ?? []) {
      for (const line of paragraph?.lines ?? []) {
        if (line) lines.push(line);
      }
    }
  }
  return lines;
}

/** Every word in the page, in tesseract's reading order. */
export function collectWords(page: OcrPage | null | undefined): OcrWord[] {
  const words: OcrWord[] = [];
  for (const line of collectLines(page)) {
    for (const word of line.words ?? []) {
      if (word) words.push(word);
    }
  }
  return words;
}

function wordsOfBlock(block: OcrBlock): OcrWord[] {
  const words: OcrWord[] = [];
  for (const paragraph of block?.paragraphs ?? []) {
    for (const line of paragraph?.lines ?? []) {
      for (const word of line?.words ?? []) {
        if (word) words.push(word);
      }
    }
  }
  return words;
}

function meanConfidence(words: OcrWord[]): number {
  const usable = words.map((w) => w.confidence).filter((c) => Number.isFinite(c));
  if (usable.length === 0) return 0;
  return usable.reduce((sum, c) => sum + c, 0) / usable.length;
}

/* ------------------------------------------------------------------ */
/* cleanText                                                           */
/* ------------------------------------------------------------------ */

/**
 * Tidies the raw page text without touching the words themselves.
 *
 * Tesseract emits CRLF on some platforms, pads short lines with trailing
 * spaces, and leaves a run of blank lines wherever it decided a gap was a
 * paragraph break. Interior runs of spaces are deliberately left alone, since
 * they are the only column information plain text output carries.
 */
export function cleanText(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/* ------------------------------------------------------------------ */
/* toBlocks                                                            */
/* ------------------------------------------------------------------ */

/**
 * A per block report: the block's text, its mean word confidence, and a marker
 * on any block that averages under the low confidence threshold. Blocks are how
 * tesseract segments a page, so this is the view that tells you which column,
 * caption, or footer the engine struggled with.
 */
export function toBlocks(page: OcrPage | null | undefined): string {
  const blocks = page?.blocks ?? [];
  if (blocks.length === 0) {
    return 'No text blocks were found in this image.';
  }

  const total = blocks.length;
  const sections = blocks.map((block, index) => {
    const words = wordsOfBlock(block);
    const confidence = words.length > 0 ? meanConfidence(words) : (block.confidence ?? 0);
    const rounded = Math.round(confidence);
    const marker = confidence < LOW_CONFIDENCE ? '  [low confidence]' : '';
    const header = `Block ${index + 1} of ${total}  mean confidence ${rounded}%${marker}`;
    const body = cleanText(block.text) || '(no text)';
    return `${header}\n${body}`;
  });

  return sections.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* toTsv                                                               */
/* ------------------------------------------------------------------ */

/** Tabs and newlines inside a word would break the row, so they become spaces. */
function tsvCell(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ');
}

/**
 * Tab separated words with their confidence and pixel box, ready to paste into
 * a spreadsheet. The header is always present so an empty page still produces a
 * valid file rather than a zero byte one.
 */
export function toTsv(words: OcrWord[] | null | undefined): string {
  const header = 'text\tconfidence\tx0\ty0\tx1\ty1';
  const rows = (words ?? []).map((word) => {
    const bbox = word.bbox ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
    return [
      tsvCell(word.text ?? ''),
      Math.round(word.confidence ?? 0),
      Math.round(bbox.x0),
      Math.round(bbox.y0),
      Math.round(bbox.x1),
      Math.round(bbox.y1),
    ].join('\t');
  });
  return [header, ...rows].join('\n');
}

/* ------------------------------------------------------------------ */
/* reconstructLayout                                                   */
/* ------------------------------------------------------------------ */

/**
 * Approximates the page layout in monospace text using word positions.
 *
 * The formula is deliberately self scaling, because nothing here knows the font
 * size: one character is assumed to be the median of `(x1 - x0) / text.length`
 * across every line, so a 4000 pixel scan and a 400 pixel screenshot both land
 * on sensible indents. A line starting at `x0` is then indented by
 * `round(x0 / charWidth)` spaces, clamped so it cannot run past the page.
 *
 * A vertical gap larger than the median line height becomes one blank line,
 * which is what makes paragraph and table row breaks survive.
 *
 * @param lines lines with `text` and `bbox`, in any order (they are sorted here)
 * @param pageWidth image width in pixels; 0 means "do not clamp"
 */
export function reconstructLayout(
  lines: OcrLine[] | null | undefined,
  pageWidth: number,
): string {
  const usable = (lines ?? []).filter((line) => (line?.text ?? '').trim().length > 0);
  if (usable.length === 0) return '';

  const charWidth = median(
    usable.map((line) => bboxWidth(line.bbox) / line.text.trim().length),
  );
  const lineHeight = median(usable.map((line) => bboxHeight(line.bbox)));

  const sorted = [...usable].sort((a, b) => {
    const dy = (a.bbox?.y0 ?? 0) - (b.bbox?.y0 ?? 0);
    return dy !== 0 ? dy : (a.bbox?.x0 ?? 0) - (b.bbox?.x0 ?? 0);
  });

  // Without a usable character width there is nothing to indent against, so the
  // honest fallback is the plain reading order.
  if (charWidth <= 0) {
    return sorted.map((line) => line.text.trim()).join('\n');
  }

  const maxColumns = pageWidth > 0 ? Math.max(1, Math.floor(pageWidth / charWidth)) : 0;
  const out: string[] = [];
  let previousBottom: number | null = null;

  for (const line of sorted) {
    const text = line.text.trim();
    const top = line.bbox?.y0 ?? 0;
    if (previousBottom !== null && lineHeight > 0 && top - previousBottom > lineHeight) {
      out.push('');
    }
    previousBottom = line.bbox?.y1 ?? top;

    let indent = Math.max(0, Math.round((line.bbox?.x0 ?? 0) / charWidth));
    if (maxColumns > 0) indent = Math.min(indent, Math.max(0, maxColumns - text.length));
    out.push(' '.repeat(indent) + text);
  }

  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* confidenceSummary                                                   */
/* ------------------------------------------------------------------ */

export interface ConfidenceSummary {
  wordCount: number;
  /** Mean word confidence as a percentage, to one decimal place. */
  mean: number;
  /** How many words scored under the low confidence threshold. */
  lowConfidenceCount: number;
  verdict: 'great' | 'good' | 'poor';
  /** One line fit for showing under the output, verdict and advice included. */
  summary: string;
}

/**
 * Scores a recognition run. The verdict is about the image, not the engine:
 * tesseract is accurate on clean, level, high resolution text and unreliable on
 * anything else, so a poor score points at the photo rather than apologizing.
 */
export function confidenceSummary(words: OcrWord[] | null | undefined): ConfidenceSummary {
  const list = words ?? [];
  const wordCount = list.length;

  if (wordCount === 0) {
    return {
      wordCount: 0,
      mean: 0,
      lowConfidenceCount: 0,
      verdict: 'poor',
      summary:
        'No words were recognized. Try a higher resolution image, or straighten and crop the photo so the text sits level.',
    };
  }

  const mean = meanConfidence(list);
  const lowConfidenceCount = list.filter(
    (word) => (word.confidence ?? 0) < LOW_CONFIDENCE,
  ).length;

  const verdict: ConfidenceSummary['verdict'] =
    mean >= 85 ? 'great' : mean >= 70 ? 'good' : 'poor';

  const advice =
    verdict === 'great'
      ? 'Quality looks great.'
      : verdict === 'good'
        ? 'Quality looks good, so check the low confidence words before you trust them.'
        : 'Quality looks poor. Try a higher resolution scan, or straighten and crop the photo so the text sits level.';

  const counted = `${wordCount} word${wordCount === 1 ? '' : 's'}`;
  const low = `${lowConfidenceCount} under ${LOW_CONFIDENCE}%`;

  return {
    wordCount,
    mean: Math.round(mean * 10) / 10,
    lowConfidenceCount,
    verdict,
    summary: `${counted}, mean confidence ${Math.round(mean)}%, ${low}. ${advice}`,
  };
}

/* ------------------------------------------------------------------ */
/* formatting                                                          */
/* ------------------------------------------------------------------ */

/**
 * Renders one recognition result in the chosen format. The panel keeps the
 * result in memory and calls this again when the format switches, so changing
 * the view never re-runs recognition.
 *
 * @param pageWidth image width in pixels, used only by the layout rebuild
 */
export function formatResult(
  page: OcrPage | null | undefined,
  opts: Pick<OcrOpts, 'format' | 'preserveLayout'>,
  pageWidth = 0,
): string {
  const format = String(opts?.format ?? 'text');
  if (format === 'tsv') return toTsv(collectWords(page));
  if (format === 'blocks') return toBlocks(page);
  if (opts?.preserveLayout) {
    const lines = collectLines(page);
    if (lines.length > 0) return reconstructLayout(lines, pageWidth);
  }
  return cleanText(page?.text);
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

function describeSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Recognition needs the tesseract worker, which this layer is not allowed to
 * start, so `run` reports what the panel is about to do with the image and the
 * options rather than pretending to do it. Every formatter above is exported,
 * and the panel uses exactly those.
 */
export function run(input: Uint8Array | string, opts: OcrOpts): Record<string, string> {
  if (input === null || input === undefined || input.length === 0) {
    throw new ToolError(
      'empty-input',
      'No image was provided.',
      'Drop a screenshot or photo onto the panel, pick one with the file button, or paste one with Ctrl+V.',
    );
  }
  if (typeof input === 'string') {
    throw new ToolError(
      'not-an-image',
      'This tool needs image bytes, but it received text.',
      'Drop or paste an image instead. There is nothing to recognize in text that has already been typed out.',
    );
  }

  const language = String(opts?.language ?? 'eng');
  const pack = LANGUAGES[language];
  if (!pack) {
    throw new ToolError(
      'unsupported-language',
      `There is no language pack for "${language}".`,
      `Choose one of the packs this site ships: ${Object.keys(LANGUAGES).join(', ')}.`,
    );
  }

  const format = String(opts?.format ?? 'text');
  const formatName = FORMATS[format];
  if (!formatName) {
    throw new ToolError(
      'unsupported-format',
      `"${format}" is not an output format this tool produces.`,
      `Choose one of: ${Object.keys(FORMATS).join(', ')}.`,
    );
  }

  const preserveLayout = opts?.preserveLayout === true;

  return {
    Engine:
      'Tesseract runs as a WebAssembly worker, so recognition happens in the panel on this page rather than in this step.',
    Image: `${describeSize(input.length)} of image data, ready to recognize.`,
    Language: `${pack.name} (${language}), about ${pack.megabytes} MB of language data to download once.`,
    'Output format': formatName,
    Layout: preserveLayout
      ? 'Indentation is rebuilt from word positions, so columns and tables keep their shape.'
      : 'Off. Text comes back in reading order without reconstructed indentation.',
    'Next step': 'Press Load OCR engine in the panel, then Extract text.',
  };
}

export default { run } satisfies ToolLogic<Uint8Array | string, Record<string, string>, OcrOpts>;
