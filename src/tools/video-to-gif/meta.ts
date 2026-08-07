import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'video-to-gif',
  matrixSlug: 'video-to-gif',
  name: 'Video to GIF',
  description: 'Trim a clip and export an optimised GIF with palette control, all in your browser.',
  category: 'Media',
  keywords: [
    'video to gif',
    'mp4 to gif',
    'convert video to gif online',
    'make a gif from a video',
    'gif palette dithering',
    'ffmpeg palettegen paletteuse',
    'trim video to gif',
    'high quality gif converter',
  ],
  input: 'video/*',
  output: 'application/json',
  options: [
    { kind: 'text', id: 'start', label: 'Start', default: '', placeholder: '0:00' },
    { kind: 'text', id: 'end', label: 'End', default: '', placeholder: 'end of clip' },
    { kind: 'number', id: 'fps', label: 'Frames per second', default: 12, min: 1, max: 30 },
    { kind: 'number', id: 'width', label: 'Width in pixels', default: 480, min: 64, max: 1280 },
    {
      kind: 'select',
      id: 'palette',
      label: 'Palette',
      default: 'global',
      choices: [
        { value: 'global', label: 'One palette for the whole clip' },
        { value: 'perframe', label: 'A new palette on every frame' },
      ],
    },
    {
      kind: 'select',
      id: 'dither',
      label: 'Dithering',
      default: 'sierra2_4a',
      choices: [
        { value: 'sierra2_4a', label: 'Sierra2 4a (smooth gradients)' },
        { value: 'bayer', label: 'Bayer (patterned, smaller file)' },
        { value: 'none', label: 'None (flat bands, sharpest text)' },
      ],
    },
    { kind: 'boolean', id: 'loop', label: 'Loop forever', default: true },
  ],
  copy: {
    what: 'Turns a video clip into a GIF using the real two filter ffmpeg pipeline: palettegen builds a 256 color table from your footage, then paletteuse quantizes the frames against it. That is what separates a clean GIF from the muddy, banded output most converters produce. You control the trim window, the frame rate, the width, whether the palette is built once for the whole clip or fresh on every frame, which dithering method smooths the color steps, and whether the result loops. ffmpeg runs inside this tab through WebAssembly, so the clip stays on your machine.',
    how: 'Drop a video in, or pick one, then press "Load media engine" the first time (a one time download your browser keeps afterwards). Type a start and end time as seconds, mm:ss, or hh:mm:ss to trim, and set the frame rate and width for the size you need. Press Convert, watch the progress, then preview the GIF and download it. If the frame estimate warns you, cut the range or drop the frame rate before running.',
    why: 'The GIF sites cap you at a few seconds, watermark the output, queue you behind other jobs, and upload your clip to do it. Most of them also skip the palette pass entirely, which is why their GIFs look like they came out of 1998. This does the proper two pass palette pipeline locally, with no length cap beyond what your machine can hold, no watermark, and no signup: your files and inputs never leave your device.',
    faq: [
      {
        q: 'Why do my GIFs look banded or blotchy?',
        a: 'GIF allows only 256 colors per palette, so every gradient has to be approximated. A global palette picks one table for the whole clip, which is small but drifts when the scene changes; a per frame palette gives each frame its own 256 colors and handles those shifts at the cost of file size. Dithering is the other half: Sierra2 4a scatters the error to fake extra shades and looks smoothest, Bayer uses a fixed crosshatch that stays still between frames and compresses better, and turning dithering off gives flat bands that suit screen recordings and line art. If you see blotches, try the per frame palette; if you see moving grain, try Bayer or no dithering.',
      },
      {
        q: 'Why is the GIF so much bigger than the video?',
        a: 'GIF has no interframe compression worth the name and no modern entropy coding, so a clip that is 2 MB as MP4 can easily be 20 MB as GIF. The levers that actually work are length, frame rate, and width, in that order: trim harder, drop to 10 or 12 frames per second, and scale to 480 pixels wide or less. Palette and dithering choices change size too, but only by tens of percent. If the destination accepts video at all, an MP4 or WebM will look better and weigh far less.',
      },
      {
        q: 'Is my video uploaded anywhere?',
        a: 'No. The ffmpeg engine is downloaded once and then runs inside this tab, reading the file straight from memory: your files and inputs never leave your device. Nothing about the clip is logged or sent on, and the finished GIF is built and downloaded locally.',
      },
    ],
  },
};
