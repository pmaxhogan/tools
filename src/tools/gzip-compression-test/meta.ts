import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'gzip-compression-test',
  icon: 'FileArchive',
  matrixSlug: 'compress',
  name: 'Compression Lab',
  description:
    'Run text or files through gzip and deflate, compare sizes, and inspect compressed data.',
  category: 'Files',
  keywords: [
    'gzip compression test',
    'compression ratio calculator',
    'deflate online',
    'gzip decompress online',
    'how compressible is my file',
    'gzip vs deflate',
    'test gzip compression',
    'file entropy calculator',
  ],
  searchTerms: [
    'gzip online',
    'compress file online',
    'zlib test',
    'shannon entropy calculator',
    'gunzip online',
    'compressionstream test',
    'compare compression algorithms',
    'gz decompress browser',
    'how well does this compress',
  ],
  input: 'File',
  output: 'application/json',
  options: [
    {
      kind: 'boolean',
      id: 'preview',
      label: 'Show hex preview of compressed gzip bytes',
      default: true,
    },
  ],
  copy: {
    what: 'Runs pasted text or a dropped file through gzip, deflate, and deflate-raw at the same time and compares the resulting sizes, percent saved, and a Shannon entropy estimate of how compressible the input is. Drop in an already-compressed .gz file instead and it detects the format, decompresses it, and shows a text preview of the result.',
    how: 'Paste text or drop a file into the input. If the input looks uncompressed, all three algorithms run automatically and the smallest result is called out as the winner. If the input is already gzip or zlib compressed, it decompresses instead and shows the original and decompressed sizes plus a preview of the content.',
    why: 'The incumbent compression testers upload your file to a server to compress it, which is slow and means your data left your device for a size comparison. This one runs the browser\'s own CompressionStream and DecompressionStream engines locally: your files and inputs never leave your device.',
    faq: [
      {
        q: 'What compression algorithms are supported?',
        a: 'gzip, deflate, and deflate-raw, all via the browser\'s built-in compression engine (the standard CompressionStream and DecompressionStream APIs). Deflate-raw is the same algorithm as deflate but without the zlib header and checksum bytes.',
      },
      {
        q: 'Can it decompress files, not just compress them?',
        a: 'Yes. Drop a .gz file (or any gzip or zlib compressed data) and it is detected automatically by its magic bytes, decompressed, and shown with its original size, decompressed size, and a text preview.',
      },
      {
        q: 'Is my file uploaded anywhere?',
        a: 'No. Your files and inputs never leave your device: compression and decompression both run locally in your browser.',
      },
    ],
  },
};
