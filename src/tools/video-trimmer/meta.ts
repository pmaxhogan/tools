import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "video-trimmer",
  icon: "SquareScissors",
  matrixSlug: "frame-trim",
  name: "Video Trimmer",
  description: "Cut video precisely in the browser using WebCodecs, re-encoding only what it must.",
  category: "Media",
  keywords: [
    "video trimmer",
    "trim video online",
    "cut video in browser",
    "frame accurate trim",
    "webcodecs video editor",
    "clip a video without uploading",
    "trim mp4 to webm",
  ],
  searchTerms: [
    "cut video clip",
    "video cutter online",
    "clip video without upload",
    "crop video length",
    "video editor trim",
    "webcodecs trimmer",
    "cut video to length",
    "remove part of video",
    "video splitter",
    "shorten video clip",
  ],
  input: "video/*",
  output: "application/json",
  options: [
    { kind: "text", id: "start", label: "Start", default: "0", placeholder: "0:00" },
    { kind: "text", id: "end", label: "End", default: "", placeholder: "end of clip" },
    { kind: "number", id: "fps", label: "Frame rate", default: 30, min: 1, max: 120 },
  ],
  copy: {
    what: "Trims a video down to one range, entirely inside this tab. You set the start and end with the playhead or by typing a timecode, step a frame at a time to land on the exact moment, and the panel shows which frames the range covers before you commit. The trimmed clip comes back as WebM (VP9 where the browser supports it, otherwise VP8) at a high bitrate. The boundaries are frame accurate going in, and the output is re-encoded rather than copied, so this is a clean cut rather than a lossless one.",
    how: 'Drop a video file in, or pick one, and let the preview load. Scrub to where the clip should begin and press "Set start", then scrub to the end and press "Set end", nudging with the frame step buttons if you need a specific frame. Check the frame readout, press Trim, and let the clip play through once while it records. When it finishes you get a preview, the output size, and a download button.',
    why: "The popular trimming sites make you upload the whole file, cap the length or the resolution, watermark the result, or hold the download behind a signup. Desktop editors do a better job but are far too much software for cutting ten seconds out of a screen recording. This runs in the tab you already have open: your files and inputs never leave your device, there is no length limit beyond what your machine can hold, and the result downloads straight away.",
    faq: [
      {
        q: "Is the cut lossless?",
        a: "No. The selected range is re-encoded to WebM at a high bitrate (about 8 Mbps for video), so quality stays close to the source but the file is not a byte for byte copy of the original frames. A true smart cut, copying the untouched groups of pictures and re-encoding only the two boundaries, needs an MP4 demuxer and muxer that browsers do not expose today. It is a planned upgrade rather than something this version does.",
      },
      {
        q: "Why is the output WebM instead of MP4?",
        a: "WebM with VP9 or VP8 is the format browsers can actually write. Browser video encoders do not offer MP4 or H.264 output without shipping a large encoder alongside the page, so the trimmer uses what is already built in. Most players, editors, and sites accept WebM, and if you need MP4 you can run the result through the A/V converter on this site.",
      },
      {
        q: "Is my video uploaded anywhere?",
        a: "No. The file is read, decoded, played, and re-encoded by your own browser, and the download comes from memory in this tab: your files and inputs never leave your device. Nothing about the clip is logged or sent on.",
      },
    ],
  },
};
