import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "screen-recorder",
  icon: "MonitorPlay",
  name: "Screen Recorder",
  description:
    "Record your screen, a window, or a browser tab locally, with optional microphone and system audio, no account and no watermark.",
  category: "Capture",
  keywords: [
    "screen recorder",
    "record screen browser",
    "no watermark screen recording",
    "webm screen capture",
    "record a tab",
    "free screen recorder no signup",
  ],
  searchTerms: [
    "loom alternative",
    "record my screen online",
    "capture browser tab video",
    "screen capture no download",
    "record window video",
    "getdisplaymedia recorder",
    "obs alternative browser",
    "record tab audio",
    "screen capture no watermark",
  ],
  input: "none",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "quality",
      label: "Quality",
      default: "1080p",
      options: [
        {
          value: "1080p-high",
          label: "1080p high",
          synonyms: ["high bitrate", "best quality", "8000 kbps"],
        },
        {
          value: "1080p",
          label: "1080p",
          synonyms: ["full hd", "1920x1080", "5000 kbps"],
        },
        {
          value: "720p",
          label: "720p",
          synonyms: ["hd", "1280x720", "2500 kbps", "smaller file"],
        },
        {
          value: "low",
          label: "Low",
          synonyms: ["small file size", "low bitrate", "1000 kbps"],
        },
      ],
    },
    {
      kind: "select",
      id: "format",
      label: "Export format",
      default: "webm",
      options: [
        {
          value: "webm",
          label: "WebM",
          synonyms: ["vp9", "native format", "instant export"],
        },
        {
          value: "mp4",
          label: "MP4",
          synonyms: ["h264", "convert to mp4", "universal playback"],
        },
      ],
    },
    { kind: "boolean", id: "micAudio", label: "Include microphone", default: false },
    { kind: "boolean", id: "systemAudio", label: "Include system/tab audio", default: true },
  ],
  copy: {
    what: "Records your screen, an application window, or a single browser tab directly in the browser, using the same getDisplayMedia capture the OS screen-share picker uses. Add microphone audio, system or tab audio, or both, then export instantly as WebM or convert to MP4 with an in-browser ffmpeg pass. No account, no time limit banner, and no watermark burned into the video.",
    how: "Pick a quality preset, choose WebM or MP4, and toggle microphone and system audio on or off. Start the recording, pick the screen, window, or tab to share in the browser's own picker, and stop it when done. WebM downloads immediately; choosing MP4 runs a local conversion pass before the download starts.",
    why: "Most free screen recorders either stamp a watermark on the output, cap you at a few minutes, or require an account before you can download anything. This one runs entirely in your browser: the recording never leaves your device, so there is nothing to upload, no processing queue, and no upsell screen between you and the file.",
    faq: [
      {
        q: "Is my recording uploaded anywhere?",
        a: "No. Capture, encoding, and any MP4 conversion all happen locally in your browser. The video file never leaves your device.",
      },
      {
        q: "Can I get an MP4 instead of WebM?",
        a: "Yes. Choose MP4 as the export format and the recording is converted in your browser after you stop recording, using the same ffmpeg engine as the other media tools here.",
      },
      {
        q: "Does it capture audio, and from where?",
        a: "You can include microphone audio, system or tab audio (when the browser's share picker offers it), or both. Leave both off to record video only.",
      },
    ],
  },
};
