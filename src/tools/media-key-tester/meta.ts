import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "media-key-tester",
  matrixSlug: "media-keys",
  icon: "Play",
  name: "Media Key Tester",
  description:
    "Verify Media Session action handlers and hardware media keys, and see whether your headset or keyboard buttons actually reach the page.",
  category: "Testers",
  keywords: [
    "media key tester",
    "test media keys",
    "media session api test",
    "play pause key not working",
    "keyboard media keys test",
    "headphone button test",
  ],
  searchTerms: [
    "hardware media key test",
    "media session action handler test",
    "bluetooth headset button test",
    "keyboard multimedia keys not working",
    "navigator.mediaSession test",
    "play pause button test",
    "volume key test browser",
    "car stereo button test",
    "media session api demo",
    "airpods button test",
    "next track button test",
    "mute button test",
    "stop button test",
    "lock screen media controls test",
    "next track key test",
    "media session api tester",
    "keyboard multimedia key debug",
  ],
  input: "application/json",
  output: "application/json",
  copy: {
    what: "Media Key Tester registers a handler for every Media Session action (play, pause, seek, track skip, and the less common conferencing and slide actions) and listens for the raw KeyboardEvent media keys browsers sometimes fall back to. Press play/pause, stop, track skip, volume, or your headset buttons, and it shows exactly what fired, in what order, and which registered handlers never fired at all.",
    how: "Click the panel's play button first; a silent looping audio clip starts so the browser assigns this page a media session, which is required before the OS will route hardware keys here at all. Then press the keys or headset buttons you want to test. Each event is logged live, and the summary reports whether keys arrived through Media Session, through plain KeyboardEvents, or not at all, along with a support breakdown for this browser.",
    why: "Media key bugs are notoriously hard to isolate: is the OS eating the key, is another app holding the media session, or is the page's own handler code wrong? This tool isolates the page's own behavior with a live, labeled log instead of a demo video, and never sends what you type or press anywhere; the whole test runs on your device.",
    faq: [
      {
        q: "Why does nothing happen until I click play?",
        a: "Browsers only grant a page control of the OS media session while it has an active (or recently active) audio or video element, so the panel starts a silent looping clip on click to claim that session. Without it, the OS has no reason to route hardware keys to this tab at all.",
      },
      {
        q: "Why do volume keys never show up here?",
        a: "Volume is not a Media Session action and is not delivered to web pages as a KeyboardEvent either; the OS or the hardware handles it directly and never tells the page. The volume rows in the keyboard key list exist because some external keyboards can technically send AudioVolumeUp/Down/Mute key events, but on most laptops and phones you will never see them fire here, and that is expected, not a bug.",
      },
      {
        q: "How do I make my headset or Bluetooth button work with this page?",
        a: "Click play here so the browser owns the media session, then make sure no other app (a music player, a call app, another browser tab) currently holds it, since only one media session is usually active at a time. If your headset button still does nothing, try it while audio is actually playing: several operating systems only forward the button while something is audible.",
      },
    ],
  },
};
