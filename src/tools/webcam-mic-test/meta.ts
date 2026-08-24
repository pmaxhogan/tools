import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "webcam-mic-test",
  matrixSlug: "av-test",
  icon: "Webcam",
  name: "Webcam & Mic Test",
  description:
    "Preview your camera, test your microphone, and watch live audio levels before a call, entirely in your browser.",
  category: "Testers",
  keywords: [
    "webcam test",
    "mic test online",
    "microphone test",
    "camera test",
    "check my webcam",
    "audio level meter",
  ],
  searchTerms: [
    "test my camera",
    "test my microphone",
    "video call check",
    "mic level meter",
    "camera not working",
    "microphone not working",
    "mirror video",
    "before a call checklist",
    "webcam preview",
    "sound check before meeting",
    "webcam not detected",
    "audio input test",
    "getusermedia test",
    "camera permission test",
    "zoom camera test",
  ],
  input: "application/json",
  output: "application/json",
  requires: ["camera"],
  privacyNote:
    "The camera and microphone stream stay in the page; nothing is recorded or uploaded, and the stream stops when you press Stop or leave.",
  options: [
    {
      kind: "select",
      id: "detail",
      label: "Detail",
      default: "full",
      options: [
        {
          value: "full",
          label: "Full report",
          synonyms: ["detailed", "everything", "all fields", "verbose"],
        },
        {
          value: "summary",
          label: "Summary",
          synonyms: ["brief", "short", "quick", "minimal"],
        },
      ],
    },
  ],
  copy: {
    what: "Starts a live preview of your camera and microphone, then reports what the browser can actually see and hear: connected camera and microphone names, the exact resolution, frame rate, and facing direction of the active video track, the sample rate and processing settings of the active audio track, and a running RMS and peak level reading of your microphone so you can tell whether you sound silent, too quiet, good, loud, or clipped before joining a call.",
    how: "Press Start above the readout to grant camera and microphone permission and see the live preview, then talk normally and watch the level meter to check your mic gain. Use the mirror toggle to see how you actually look on other people's screens instead of the flipped self view. Press Stop when you are done, or just navigate away; the stream ends immediately either way.",
    why: "Most webcam test sites bury the check behind a video call product, a required account, or a browser extension. This one is a single page with no sign up: the camera and microphone stream stay in the page, nothing is recorded or uploaded, and the stream stops the moment you press Stop or leave.",
    faq: [
      {
        q: "Why is my mic level low even though I'm talking normally?",
        a: "Browsers apply automatic gain control by default, which can undercompensate for a quiet microphone or one placed far from your mouth. Check the auto gain control and noise suppression rows in the audio details, move the microphone closer, or raise the input volume in your operating system's sound settings; the level meter updates live so you can see the change immediately.",
      },
      {
        q: "Why does the browser ask for camera and microphone permission every time?",
        a: "Most browsers only remember a camera or microphone grant for as long as the site stays open, or reset it entirely in a private or incognito window, so a fresh tab often means asking again. If you test here often, you can pin the permission as always allowed from the browser's site settings.",
      },
      {
        q: "Why is the video mirrored?",
        a: "The preview flips your camera horizontally by default because that matches what you see in an actual mirror and feels natural while checking your framing, exactly like every video call app does. Use the mirror toggle above the preview to see the unflipped, true to camera view, which is what other people on a call actually see.",
      },
    ],
  },
};
