import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'svg-optimizer',
  icon: 'Feather',
  matrixSlug: 'svg-optimize',
  name: 'SVG Optimizer',
  description:
    'Run SVGO in your browser to shrink SVG files, with byte-level before and after stats.',
  category: 'Images',
  keywords: [
    'svg optimizer',
    'svgo online',
    'compress svg',
    'minify svg',
    'svg cleaner',
    'reduce svg file size',
    'optimize svg online',
    'svg file size reducer',
  ],
  searchTerms: [
    'shrink svg',
    'svg minifier',
    'clean up svg code',
    'remove svg metadata',
    'svgomg alternative',
    'svg file compressor',
    'reduce svg size',
    'strip inkscape metadata',
    'illustrator svg cleanup',
    'svg path optimizer',
  ],
  input: 'image/svg+xml',
  output: 'application/json',
  options: [
    { kind: 'boolean', id: 'multipass', label: 'Multipass (repeat until no smaller)', default: true },
    {
      kind: 'number',
      id: 'precision',
      label: 'Decimal precision',
      default: 3,
      min: 0,
      max: 8,
    },
    {
      kind: 'boolean',
      id: 'keepViewBox',
      label: 'Keep viewBox (preserves responsive scaling)',
      default: true,
    },
    { kind: 'boolean', id: 'pretty', label: 'Pretty print output', default: false },
    { kind: 'boolean', id: 'removeIds', label: 'Remove unused ids', default: false },
  ],
  copy: {
    what: 'Runs the real SVGO optimizer engine on your SVG, right in your browser, and shows byte level before and after stats. Comments, editor metadata (Inkscape and Illustrator cruft), and redundant precision get stripped, paths get merged and shortened, and the result is a smaller file that still renders identically. Toggle multipass, decimal precision, viewBox handling, pretty printing, and id cleanup to match your needs.',
    how: 'Paste an SVG file\'s markup or drop the file itself into the input. Adjust the options if you want a different tradeoff (higher precision for detailed illustrations, pretty printed output for readability, or keep unused ids for scripts and ARIA references). Copy the optimized SVG from the first output row, or read the before, after, and saved byte counts underneath.',
    why: 'The popular SVGO web frontends make you upload your artwork to a server, and many of them lag behind the actual SVGO releases with outdated defaults. This tool runs the current SVGO engine locally: your files and inputs never leave your device. A side by side preview and PNG export are coming next.',
    faq: [
      {
        q: 'Is this the real SVGO, or a reimplementation?',
        a: 'It is the actual SVGO engine, the same one that popular web based SVG optimizers wrap around a server upload.',
      },
      {
        q: 'Why does it keep the viewBox attribute by default?',
        a: 'Removing viewBox breaks an SVG\'s ability to scale responsively with CSS, so it is protected unless you turn off "Keep viewBox".',
      },
      {
        q: 'Is my SVG file uploaded anywhere?',
        a: 'No. Optimization runs entirely in your browser: your files and inputs never leave your device.',
      },
    ],
  },
};
