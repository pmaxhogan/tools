import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'video-converter',
  icon: 'Video',
  matrixSlug: 'av-converter',
  name: 'A/V Converter',
  description: 'Convert video and audio between formats locally with ffmpeg.',
  category: 'Media',
  keywords: [
    'video converter',
    'convert mov to mp4',
    'mp4 to webm converter',
    'extract audio from video',
    'convert video to mp3',
    'wav to flac converter',
    'ffmpeg in the browser',
    'offline video converter',
  ],
  searchTerms: [
    'ffmpeg online',
    'convert video format',
    'video format changer',
    'mov to mp4',
    'webm to mp4 converter',
    'audio format converter',
    'video compressor',
    'transcode video browser',
    'handbrake alternative online',
    'video codec converter',
  ],
  input: 'video/*',
  output: 'application/json',
  options: [
    {
      kind: 'select',
      id: 'target',
      label: 'Convert to',
      default: 'mp4',
      choices: [
        { value: 'mp4', label: 'MP4 video (H.264 and AAC)' },
        { value: 'webm', label: 'WebM video (VP8 and Vorbis)' },
        { value: 'mkv', label: 'MKV video (remux, no re-encode)' },
        { value: 'gif', label: 'GIF animation' },
        { value: 'mp3', label: 'MP3 audio' },
        { value: 'm4a', label: 'M4A audio (AAC)' },
        { value: 'wav', label: 'WAV audio (16 bit PCM)' },
        { value: 'ogg', label: 'OGG audio (Vorbis)' },
        { value: 'flac', label: 'FLAC audio (lossless)' },
      ],
    },
    {
      kind: 'select',
      id: 'quality',
      label: 'Quality',
      default: 'balanced',
      choices: [
        { value: 'high', label: 'High: closest to the source, slowest' },
        { value: 'balanced', label: 'Balanced: good quality, sensible size' },
        { value: 'small', label: 'Small: smallest file, softest picture' },
      ],
    },
    {
      kind: 'boolean',
      id: 'stripAudio',
      label: 'Remove the audio track',
      default: false,
    },
  ],
  copy: {
    what: 'Converts video and audio files between the formats people actually need: MP4, WebM, MKV and GIF for video, and MP3, M4A, WAV, OGG and FLAC for audio. Picking an audio format on a video file extracts the soundtrack, and the MKV option rewraps the existing streams without re-encoding, so it finishes in seconds and loses nothing. It is a real build of ffmpeg compiled to WebAssembly, running inside your browser tab, so there is no upload, no queue and no file size cap beyond what your own machine can hold.',
    how: 'Load the media engine once (about 31 MB, and your browser keeps it for later visits), then drop a video or audio file on the panel. Choose the format you want, pick a quality tier, and optionally remove the audio track. Press Convert to watch the ffmpeg progress and log, then preview the result in place and download it. Longer files take longer: a rough guide is that a short clip converts in about the time it would take to play.',
    why: 'Free converter sites upload your file to their servers, cap it at a few hundred megabytes, make you wait in a queue, and some of them stamp a watermark on the output or charge for anything longer than a minute. This one runs the real ffmpeg in your tab, so your files and inputs never leave your device, nothing is watermarked, and the only limit is your own hardware. You also get to see the exact command and the full ffmpeg log, which is the thing every other converter hides.',
    faq: [
      {
        q: 'Which formats and codecs can it actually write?',
        a: 'Video: MP4 with H.264 (libx264) and AAC, WebM with VP8 (libvpx) and Vorbis, MKV as a straight stream copy of whatever your file already contains, and animated GIF with a palette generated from the clip. Audio: MP3 (libmp3lame), M4A with AAC, WAV as 16 bit PCM, OGG with Vorbis, and FLAC. WebM is encoded as VP8 rather than VP9 on purpose: VP9 encoding in WebAssembly is several times slower for a modest size win, and honest speed beats a stalled progress bar.',
      },
      {
        q: 'Why is this slower than a desktop converter?',
        a: 'ffmpeg here is compiled to WebAssembly and runs on a single thread, while a desktop build uses every core in your machine and often the hardware encoder in your GPU. Expect roughly real time or a bit slower for a short clip, and expect long files to take a while. The MKV remux option skips encoding entirely, so it is the fast path when you only need a different container.',
      },
      {
        q: 'Is my video uploaded anywhere?',
        a: 'No. The one time engine download fetches the ffmpeg WebAssembly build from this site, and after that everything happens inside the tab: your files and inputs never leave your device. You can convert with the network off once the engine is cached.',
      },
    ],
  },
};
