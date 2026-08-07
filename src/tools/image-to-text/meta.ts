import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'image-to-text',
  icon: 'ScanText',
  matrixSlug: 'ocr',
  name: 'OCR',
  description: 'Pull text out of images with tesseract, running in your browser.',
  category: 'Local AI',
  keywords: [
    'ocr online free',
    'image to text converter',
    'extract text from image',
    'screenshot to text',
    'tesseract online',
    'picture to text',
  ],
  searchTerms: [
    'ocr',
    'read text in picture',
    'extract text from screenshot',
    'photo to text',
    'scanned document to text',
    'handwriting to text',
    'receipt scanner text',
    'copy text from image',
    'tesseract wasm',
  ],
  input: 'image/*',
  output: 'text/plain',
  options: [
    {
      kind: 'select',
      id: 'language',
      label: 'Language',
      default: 'eng',
      choices: [
        { value: 'eng', label: 'English (2.8 MB download)' },
        { value: 'spa', label: 'Spanish (2.0 MB download)' },
        { value: 'fra', label: 'French (0.7 MB download)' },
        { value: 'deu', label: 'German (1.3 MB download)' },
        { value: 'jpn', label: 'Japanese (1.9 MB download)' },
      ],
    },
    {
      kind: 'select',
      id: 'format',
      label: 'Output format',
      default: 'text',
      choices: [
        { value: 'text', label: 'Plain text' },
        { value: 'blocks', label: 'Blocks with confidence' },
        { value: 'tsv', label: 'TSV with positions' },
      ],
    },
    {
      kind: 'boolean',
      id: 'preserveLayout',
      label: 'Rebuild layout from word positions',
      default: false,
    },
  ],
  copy: {
    what: 'Reads the text in a screenshot, scan, or photo using Tesseract, the open source OCR engine, compiled to WebAssembly and run inside this page. English, Spanish, French, German, and Japanese are available, and the language pack downloads once and is then cached by your browser. Output comes back as plain text, as blocks with a confidence score for each one, or as TSV rows carrying every word with its confidence and pixel position. There is also a layout mode that rebuilds indentation from the word boxes, which is what keeps a receipt or a table readable.',
    how: 'Drop an image on the panel, pick one with the file button, or just press Ctrl+V after taking a screenshot. Choose a language, then press Load OCR engine: the engine is about 3 MB plus the language pack, and nothing downloads until you ask for it. Press Extract text and watch the progress, then copy the result or download it as a .txt file. Switching the output format re-renders the same result instantly, and the bounding box overlay draws every word on the image colored by confidence, so you can see exactly where a bad reading came from.',
    why: 'The popular OCR sites want you to upload the image first, and screenshots are usually full of private information: account numbers, addresses, half of a chat thread. They also cap you at a few pages a day and push a subscription for the rest. This runs the same Tesseract engine those sites run, except it runs on your machine, there is no page limit, and your files and inputs never leave your device.',
    faq: [
      {
        q: 'How accurate is this OCR?',
        a: 'Tesseract is excellent on clean, level, high resolution text: a screenshot, a PDF page rendered at full size, or a flatbed scan usually comes back near perfect. It degrades fast on angled phone photos, low contrast, handwriting, and heavily stylized fonts, where it will happily invent plausible looking words. That is why every run shows a confidence summary and the box overlay: check the amber and red words before you trust them, and if the score is poor, retake the image at a higher resolution with the text straight on.',
      },
      {
        q: 'Which languages can it read?',
        a: 'English, Spanish, French, German, and Japanese are shipped here, each as a separate pack that downloads only when you select it. Tesseract itself supports over 100 languages, so more can be added; these five are the ones staged on this site today. One language is loaded at a time, and switching restarts the engine with the new pack.',
      },
      {
        q: 'Is my image uploaded anywhere?',
        a: 'No. The engine, the language data, and the recognition all run inside this browser tab, so your files and inputs never leave your device. The only things fetched are the engine and the language pack themselves, both served from this site, and your browser caches them for the next visit.',
      },
    ],
  },
};
