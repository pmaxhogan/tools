import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'image-redactor',
  matrixSlug: 'redact',
  name: 'Redaction Tool',
  description: 'Black out parts of a screenshot by destroying the pixels, not hiding them.',
  category: 'Images',
  keywords: [
    'redact screenshot',
    'black out text in image',
    'censor image online',
    'remove sensitive info from screenshot',
    'safe image redaction',
    'redact image online',
    'hide personal info in screenshot',
  ],
  input: 'image/*',
  output: 'application/json',
  options: [
    {
      kind: 'select',
      id: 'mode',
      label: 'Redaction style',
      default: 'solid',
      choices: [
        { value: 'solid', label: 'Solid fill (safest)' },
        { value: 'pixelate', label: 'Pixelate (weaker)' },
      ],
    },
    {
      kind: 'select',
      id: 'color',
      label: 'Solid color',
      default: 'black',
      choices: [
        { value: 'black', label: 'Black' },
        { value: 'white', label: 'White' },
      ],
    },
    {
      kind: 'number',
      id: 'blockSize',
      label: 'Pixelate block size (px)',
      default: 12,
      min: 4,
      max: 64,
      step: 1,
    },
    {
      kind: 'select',
      id: 'format',
      label: 'Export format',
      default: 'png',
      choices: [
        { value: 'png', label: 'PNG (lossless)' },
        { value: 'jpeg', label: 'JPEG (quality 90)' },
      ],
    },
  ],
  copy: {
    what: 'Redacts a screenshot by overwriting the pixels underneath your selection, so the covered content is gone from the image data rather than parked behind a shape. Drag as many rectangles as you need; each one is applied in order and can be undone. Solid black or white fill is the default and the safest option, and a pixelate mode is available with a clear warning about its limits. There is no blur mode, because blurred text keeps enough of the original signal to be recovered.',
    how: 'Drop a screenshot onto the canvas, pick solid or pixelate, then drag a rectangle over each thing you want gone. The preview shows the real redacted pixels, not an overlay, and the sidebar lists every region with a remove button. Press Escape to cancel a drag in progress or Delete to drop the last region. Export as PNG or JPEG and the file downloads with a "-redacted" name.',
    why: 'Drawing a black box in a normal image editor can leave the text recoverable: the shape may stay on its own layer, compression artifacts around it can hint at what was there, and one forgotten flatten step ships the original. Uploading to a redaction site is worse, since sending the sensitive screenshot to a stranger is exactly the thing you were trying to avoid. This tool overwrites the pixels in your browser and re-encodes the result, so the redacted areas hold one flat color and your files and inputs never leave your device.',
    faq: [
      {
        q: 'Why is solid fill safer than pixelate or blur?',
        a: 'A solid fill replaces every sample in the region with one color, so there is no residual signal left to analyze. Pixelate keeps the average of each block, and blur keeps a low pass version of the whole area: both are deterministic functions of the original pixels, and researchers have reconstructed pixelated and blurred text by rendering candidate strings through the same transform until the output matches. That is why solid is the default here and why blur is not offered at all.',
      },
      {
        q: 'Does the exported file still contain the original metadata?',
        a: 'No. The export is re-encoded from the canvas, so it is built out of the redacted pixels alone. None of the original compressed data survives, and EXIF, XMP, and IPTC blocks, including any GPS coordinates or device name, are dropped with it. The only thing carried over is the image content you can see.',
      },
      {
        q: 'Is my screenshot uploaded anywhere?',
        a: 'No. Decoding, redaction, and encoding all happen in this tab using the canvas in your browser: your files and inputs never leave your device. The region list lives in memory only, so it is not written to the URL or to storage, and closing the tab discards it.',
      },
    ],
  },
};
