import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "browser-privacy-check",
  matrixSlug: "privacy-check",
  icon: "ShieldAlert",
  name: "Browser Privacy Check",
  description:
    "See what your browser leaks: fingerprint surface, exposed APIs, and privacy signal irony, all analyzed on your device.",
  category: "Network",
  keywords: [
    "browser privacy check",
    "browser fingerprint test",
    "canvas fingerprinting test",
    "webrtc leak test",
    "am i unique",
    "browser fingerprint entropy",
  ],
  searchTerms: [
    "fingerprint checker",
    "what does my browser leak",
    "panopticlick alternative",
    "amiunique alternative",
    "webgl fingerprint",
    "audio fingerprint",
    "font fingerprint",
    "webdriver detection test",
    "do not track check",
    "global privacy control check",
    "device memory leak",
    "hardware concurrency leak",
  ],
  input: "application/json",
  output: "application/json",
  privacyNote:
    "Every probe result is collected and analyzed locally in your browser and shown only to you; nothing is sent anywhere.",
  copy: {
    what: "Browser Privacy Check runs a set of fingerprinting probes in your browser, the same kind of signals tracking scripts use, and explains in plain English what each one reveals: your user agent, screen and hardware details, canvas and WebGL fingerprints, font list, WebRTC local IP exposure, and privacy signals like Do Not Track. It then adds up a rough entropy score across every probe that returned a value and classifies your fingerprint surface as low, moderate, or high.",
    how: "Run the probe collector panel on this page; it gathers each signal from your live browser and produces a small JSON report. That report is analyzed instantly into labeled rows grouped by category, plus flags for automation detection and WebRTC IP leaks. You can also paste a JSON report by hand if you already have one, for example one exported from another device.",
    why: "Panopticlick and AmIUnique compare you against a database on their server, which means your fingerprint has to leave your machine first. This tool never sends a single probe result anywhere: the analysis, the entropy scoring, and the flags all run in your browser, so the one thing being measured for leakiness does not itself leak.",
    faq: [
      {
        q: "Is any of this data sent to you or anyone else?",
        a: "No. The probe collector runs in your browser, the JSON report stays on your device, and the analysis on this page reads that JSON locally. Nothing is uploaded, logged, or sent to a server.",
      },
      {
        q: "Why does blocking trackers sometimes make me MORE identifiable?",
        a: "Most fingerprinting entropy comes from being unusual, not from being tracked. Turning on Do Not Track or Global Privacy Control is rare enough that it can narrow you down to a smaller group of browsers, and an unusual combination of blocked APIs can be its own fingerprint. Blocking helps against the specific signals you block, but a rare configuration is still a configuration.",
      },
      {
        q: "How accurate is the entropy score?",
        a: "It is a rough estimate, not a measurement. Each probe is assigned a fixed number of bits based on how much variation similar signals showed in older public fingerprinting studies, then the bits for whatever you actually collected are added up. Your real uniqueness depends on how many other visitors share your exact combination of values today, which no offline page can know, so treat the low, moderate, and high labels as a general sense of exposure rather than an exact number.",
      },
    ],
  },
};
