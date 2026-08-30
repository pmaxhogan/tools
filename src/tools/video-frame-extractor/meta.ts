import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "video-frame-extractor",
  icon: "Frame",
  matrixSlug: "frame-extract",
  name: "Frame Extractor",
  description:
    "Scrub any video frame by frame and save exact frames as full resolution PNG, JPEG, or WebP stills, including bursts.",
  category: "Media",
  keywords: [
    "extract frame from video",
    "video to png",
    "screenshot a video frame",
    "save frame from mp4",
    "grab still from video",
    "video frame grabber",
    "export video frames",
    "get a single frame out of a video",
  ],
  searchTerms: [
    "video still image grabber",
    "extract png from video",
    "video screenshot tool",
    "save video frame as image",
    "video thumbnail extractor",
    "frame by frame video viewer",
    "video scrubber tool",
    "capture video frame online",
    "video to image sequence",
    "burst frame capture",
    "video to jpg",
    "video snapshot",
    "pause and save frame",
    "video to webp",
    "video keyframe grabber",
    "hd frame capture",
    "save exact video timestamp",
  ],
  input: "video/*",
  output: "application/json",
  options: [
    {
      kind: "number",
      id: "count",
      label: "Burst frames",
      default: 1,
      min: 1,
      max: 30,
    },
    {
      kind: "text",
      id: "interval",
      label: "Seconds between burst frames",
      default: "1",
      placeholder: "1",
    },
    {
      kind: "select",
      id: "format",
      label: "Image format",
      default: "png",
      options: [
        {
          value: "png",
          label: "PNG (lossless)",
          synonyms: ["portable network graphics", "lossless image"],
        },
        {
          value: "jpeg",
          label: "JPEG",
          synonyms: ["jpg", "lossy image"],
        },
        {
          value: "webp",
          label: "WebP",
          synonyms: ["google webp"],
        },
      ],
    },
    {
      kind: "number",
      id: "quality",
      label: "Quality (JPEG and WebP only)",
      default: 92,
      min: 1,
      max: 100,
    },
  ],
  copy: {
    what: 'Plays a video file in your browser and saves any frame from it as a full resolution image. The player carries native controls plus a fine scrub row: step one frame back or forward, type an exact time in seconds or as hh:mm:ss.mmm, and read the current position as a timecode. "Capture this frame" draws the video onto a canvas at its native pixel size, so a 4K source produces 4K stills, and "Capture burst" takes an evenly spaced run of up to 30 frames in one pass. Captures land in a strip below the player as PNG, JPEG, or WebP, each with its own download button.',
    how: 'Drop a video onto the panel or pick one with the file button, then scrub to the moment you want with the player, the frame step buttons, or the time field. Press "Capture this frame" to add it to the strip, or set a count and an interval and press "Capture burst" for a sequence. Download frames one at a time, or use "Download all" to save the whole strip in order.',
    why: "Frame grab sites make you upload the entire video so their server can pull one still, which means waiting on a file that may be hundreds of megabytes, accepting a length cap, and handing over footage you may not want to hand over. This tool seeks and captures in the tab you already have open: your files and inputs never leave your device. Nothing is downscaled to a preview size, there is no watermark on the output, and there is no queue.",
    faq: [
      {
        q: "Why is the captured frame slightly off the timestamp I asked for?",
        a: "Video is stored as keyframes plus differences, so a browser can only present positions it can actually decode. When you ask for 12.500 seconds it seeks to the nearest decodable frame, which on a 30 fps clip may sit up to about 33 milliseconds either side. The timecode shown on each capture is the position the video really reported, not the one you typed, so what you see is what you saved.",
      },
      {
        q: "What resolution are the captures?",
        a: "The video's own. The canvas is sized from videoWidth and videoHeight, which are the decoded pixel dimensions of the source, not the size the player happens to be drawn at on screen. A 3840 by 2160 file gives 3840 by 2160 stills whether the player is full width or a thumbnail.",
      },
      {
        q: "Is my video uploaded anywhere?",
        a: "No. The file is handed to a video element through a local object URL and read pixel by pixel through a canvas in the same tab, so your files and inputs never leave your device. That also means there is no size limit beyond what your own machine can decode.",
      },
    ],
  },
};
