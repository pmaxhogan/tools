import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'file-type-identifier',
  matrixSlug: 'file-id',
  name: 'File Identifier',
  description: 'Work out what a file actually is from its bytes, ignoring the extension.',
  category: 'Files',
  keywords: [
    'file type identifier',
    'what file type is this',
    'identify file without extension',
    'magic bytes checker',
    'file signature lookup',
    'detect file format',
    'unknown file extension',
    'zip xlsx docx checker',
  ],
  searchTerms: [
    'file signature checker',
    'mime type detector',
    'what is this file',
    'no extension file',
    'file header inspector',
    'binary file identifier',
    'hex signature lookup',
    'file format detector',
    'trueid',
  ],
  input: 'File',
  output: 'application/json',
  copy: {
    what: 'Reads the first bytes of a file (or pasted text) and works out what it actually is, regardless of its extension or a missing one. It recognizes magic bytes for hundreds of binary formats, including zip-based formats like DOCX, XLSX, and EPUB, and falls back to text analysis for JSON, XML, HTML, SVG, CSV, Markdown, YAML, and more when no binary signature matches.',
    how: 'Drop a file onto the input, use the file picker, or paste text directly. The result shows the detected type, its MIME type, the typical extension, and the raw first bytes as hex, plus encoding and line-ending details when the content is text.',
    why: 'Online file identifiers upload the whole file to a server just to read a handful of header bytes. This one reads the bytes locally, your files and inputs never leave your device, and it also explains text formats such as CSV or YAML, not just binary magic numbers.',
    faq: [
      {
        q: 'How does the detection work?',
        a: 'It first checks the bytes against known binary file signatures (magic bytes). If nothing matches, it falls back to text heuristics: checking for a byte order mark, decoding as UTF-8 or UTF-16, then classifying the text as JSON, XML, CSV, Markdown, and so on.',
      },
      {
        q: 'Can it tell a DOCX or XLSX apart from a plain ZIP file?',
        a: 'Yes. DOCX, XLSX, PPTX, and EPUB are all ZIP containers with specific internal file layouts, and the detector inspects the ZIP contents to tell them apart from a generic ZIP archive.',
      },
      {
        q: 'Is my file uploaded anywhere?',
        a: 'No. Your files and inputs never leave your device: detection runs entirely in your browser.',
      },
    ],
  },
};
