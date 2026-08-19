import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "element-recorder",
  matrixSlug: "element-recorder",
  icon: "Video",
  name: "Element Recorder",
  description:
    "Record a single element or a hand-drawn region of this tab to video, instead of the whole screen.",
  category: "Capture",
  keywords: [
    "record part of screen",
    "record a region of the browser tab",
    "record single element video",
    "region capture api",
    "crop screen recording browser",
    "record dom element to video",
  ],
  searchTerms: [
    "crop target api",
    "record just one element",
    "loom alternative for one widget",
    "record a div to video",
    "canvas crop recording fallback",
    "getdisplaymedia prefer current tab",
  ],
  input: "application/json",
  output: "application/json",
  privacyNote:
    "The recording stays in the page and downloads directly; nothing is uploaded.",
  options: [
    {
      kind: "select",
      id: "quality",
      label: "Quality",
      default: "medium",
      options: [
        {
          value: "low",
          label: "Low",
          synonyms: ["small file size", "low bitrate", "compact"],
        },
        {
          value: "medium",
          label: "Medium",
          synonyms: ["default", "balanced", "standard quality"],
        },
        {
          value: "high",
          label: "High",
          synonyms: ["best quality", "sharp", "large file", "high bitrate"],
        },
      ],
    },
    {
      kind: "number",
      id: "fps",
      label: "Frame rate",
      default: 30,
      min: 5,
      max: 60,
      step: 1,
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
          value: "mp4-if-supported",
          label: "MP4 if supported",
          synonyms: ["mp4", "h264", "fall back to webm"],
        },
      ],
    },
  ],
  copy: {
    what: "Crops a screen or tab recording down to a single element or a hand-drawn rectangle, so the exported video only shows the part of the page you actually care about. On Chromium browsers it uses the Region Capture API, cropping the capture stream itself with CropTarget.fromElement before encoding. On browsers without that API it falls back to capturing the full tab and cropping every frame into a canvas before recording. Either way the output is a normal WebM (or MP4 where supported) file with no watermark and no length limit.",
    how: "Draw a rectangle over the part of the page you want to record, or switch to pick mode and click an element to snap the region to its bounding box. Choose a quality, frame rate, and export format, press Start, and pick this tab in the browser's share prompt. Stop the recording for an instant preview and download, with a correct duration written into the file even though MediaRecorder normally leaves that header blank.",
    why: "Most screen recorders capture the whole tab or window and leave you to crop the video afterward in an editor. This tool crops during capture, or during a lightweight canvas pass when the browser cannot crop natively, so the file you download is already just the region you wanted, recorded and encoded entirely on your device.",
    faq: [
      {
        q: "Which browsers support recording a single element?",
        a: "Region Capture, the API that crops the capture stream to one element, needs Chromium 104 or newer: Chrome, Edge, Opera, and other Chromium based browsers. Firefox and Safari do not support it yet, so this tool falls back to capturing the full tab and cropping each frame into a canvas before recording, which uses more CPU but still produces a video limited to the region you picked.",
      },
      {
        q: "Can I record a region of another app's window, not just this browser tab?",
        a: "The overlay and pick mode only draw over this page, so they can only define a region within this tab. To record another window, choose that window instead of this tab in the browser's share picker; the tool then uses the canvas crop path, letting you draw a region over the shared window's preview instead of an element on this page.",
      },
      {
        q: "How do quality and frame rate affect the file size?",
        a: "Higher quality and a higher frame rate both raise the video bitrate, which raises file size for the same recording length: low quality at 30 fps produces a noticeably smaller file than high quality at 60 fps. The estimated bitrate shown before you record scales with the region's pixel size and your quality choice, so a small cropped region stays small even at high quality.",
      },
    ],
  },
};
