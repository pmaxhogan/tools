import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'subtitle-editor',
  matrixSlug: 'subtitles',
  name: 'Subtitle Editor',
  description: 'Convert, resync, shift and clean SRT and VTT subtitle files.',
  category: 'Media',
  keywords: [
    'srt to vtt converter',
    'vtt to srt',
    'shift subtitles online',
    'resync subtitles',
    'subtitle time shift',
    'fix subtitle timing',
    'subtitle editor',
    'clean up srt file',
  ],
  input: 'text/plain',
  output: 'text/plain',
  options: [
    {
      kind: 'select',
      id: 'operation',
      label: 'Operation',
      default: 'convert',
      choices: [
        { value: 'convert', label: 'Convert format' },
        { value: 'shift', label: 'Shift timing' },
        { value: 'resync', label: 'Resync from two anchors' },
        { value: 'clean', label: 'Clean up' },
      ],
    },
    {
      kind: 'select',
      id: 'format',
      label: 'Convert to',
      default: 'vtt',
      choices: [
        { value: 'vtt', label: 'WebVTT (.vtt)' },
        { value: 'srt', label: 'SubRip (.srt)' },
      ],
    },
    {
      kind: 'text',
      id: 'offset',
      label: 'Shift by',
      default: '+0',
      placeholder: '+2.5, -500ms, +1:03, 1500',
    },
    {
      kind: 'text',
      id: 'first',
      label: 'Resync: correct time of the first cue',
      default: '',
      placeholder: '00:00:12.400',
    },
    {
      kind: 'text',
      id: 'last',
      label: 'Resync: correct time of the last cue',
      default: '',
      placeholder: '01:48:07.900',
    },
    {
      kind: 'number',
      id: 'minDuration',
      label: 'Clean: minimum cue length (ms)',
      default: 500,
      min: 0,
      max: 5000,
      step: 50,
    },
  ],
  http: { method: 'POST', contentType: 'text/plain' },
  copy: {
    what: 'Reads SRT and WebVTT subtitles, works out which format you pasted, and writes back either one. It can also move every cue by a fixed offset, resync a whole file from two anchor points, and clean up messy captions by renumbering, stripping stray markup, folding overlong cues down to two lines, trimming overlaps and enforcing a minimum cue length. WebVTT comments, styling blocks, cue identifiers and cue settings survive a WebVTT to WebVTT pass; speaker voice spans become plain speaker prefixes when you convert to SRT, and italic and bold markup carries across intact.',
    how: 'Paste your subtitle text or drop a .srt or .vtt file on the input. Pick an operation: convert changes the format, shift moves every cue by an amount like +2.5, -500ms or +1:03, resync takes the correct new times for the first and last cue and scales everything in between, and clean tidies numbering, tags, overlaps and cue length. Copy the result and save it next to your video with the matching extension.',
    why: 'Most subtitle sites cap the file size, bury the button under ads, and upload your file to a server before they touch a single timestamp. This one parses everything in the page, so your files and inputs never leave your device, and the only size limit is your own machine. It also does a real linear resync from two anchors, which is what actually fixes framerate drift, instead of offering only a constant shift.',
    faq: [
      {
        q: 'How do I fix subtitles that drift further out of sync as the film goes on?',
        a: 'Use the resync operation. Note the correct time for the very first line of dialogue and the correct time for the very last one, enter both, and every cue in between is scaled to match. Growing drift means the subtitles were timed against a different framerate, so no constant shift can ever fix it, but a two point linear resync can.',
      },
      {
        q: 'What is the difference between SRT and VTT?',
        a: 'SRT is the older and simpler format: numbered cues, comma decimals in the timestamps, and almost no styling. WebVTT is the web standard: it opens with a WEBVTT line, uses dot decimals, and adds cue identifiers, positioning settings, comments and CSS styling. Browsers play WebVTT natively, while most desktop players, TVs and media servers expect SRT.',
      },
      {
        q: 'Is my subtitle file uploaded anywhere?',
        a: 'No. Parsing, retiming and conversion all run in your browser, so your files and inputs never leave your device.',
      },
    ],
  },
};
