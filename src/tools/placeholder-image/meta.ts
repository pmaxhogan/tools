import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'placeholder-image',
  matrixSlug: 'placeholder',
  name: 'Placeholder Images',
  description: 'Generate sized placeholder images and inline data URIs.',
  category: 'Images',
  keywords: [
    'placeholder image',
    'placeholder generator',
    'svg placeholder',
    'dummy image',
    'image data uri',
    'lorem picsum alternative',
    'mock image',
  ],
  searchTerms: [
    'dummy image generator',
    'fake image placeholder',
    'image stub',
    'test image generator',
    'lorem ipsum image',
    'placeholder.com alternative',
    'placekitten alternative',
    'sample image generator',
    'wireframe image',
    'stock placeholder graphic',
  ],
  input: 'none',
  output: 'application/json',
  options: [
    { kind: 'number', id: 'width', label: 'Width', default: 600, min: 1, max: 4000 },
    { kind: 'number', id: 'height', label: 'Height', default: 400, min: 1, max: 4000 },
    {
      kind: 'text',
      id: 'background',
      label: 'Background color',
      default: '#e2e8f0',
      placeholder: '#e2e8f0',
    },
    {
      kind: 'text',
      id: 'foreground',
      label: 'Text color',
      default: '#64748b',
      placeholder: '#64748b',
    },
    {
      kind: 'text',
      id: 'label',
      label: 'Label',
      default: '',
      placeholder: 'Leave blank to show dimensions',
    },
  ],
  http: { method: 'GET', contentType: 'application/json' },
  copy: {
    what: 'Generates a sized placeholder image as clean SVG markup, with no server round trip. Pick a width, height, background color, and text color, and it renders a centered label (by default the pixel dimensions) as valid SVG, a data URI, an <img> tag, and a CSS background-image declaration.',
    how: 'Set width and height (1-4000px), pick hex colors for the background and label text, and optionally type a custom label. Copy whichever output you need: the raw SVG markup to drop in a file, the data URI to embed inline, the ready-made <img> tag, or the CSS declaration for a background-image.',
    why: 'Services like placeholder.com or picsum.photos require a live network request every time the image loads, track referrers, and can go down. This generates the SVG locally as text: no image ever leaves your device, no requests, no rate limits, no attribution needed.',
    faq: [
      {
        q: 'Why SVG instead of a PNG or JPG?',
        a: 'SVG is text, so it can be generated instantly in the browser without an image-encoding library, scales to any size with no blur, and produces a tiny data URI.',
      },
      {
        q: 'What if I leave the label blank?',
        a: 'The label defaults to the image dimensions, like "600×400", which is the standard placeholder convention.',
      },
      {
        q: 'Can I use the output directly as an <img> src?',
        a: 'Yes, copy the "Data URI" or "HTML img tag" output. Both work immediately with no hosting required.',
      },
    ],
  },
};
