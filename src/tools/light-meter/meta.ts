import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "light-meter",
  matrixSlug: "light-meter",
  name: "Light Meter",
  description: "Camera-based lux and color temperature estimates.",
  category: "Mobile",
  icon: "Sun",
  keywords: [
    "light meter app browser",
    "lux meter online",
    "measure light with phone camera",
    "color temperature estimate",
    "exposure meter webcam",
    "how bright is my room",
  ],
  searchTerms: [
    "lux meter",
    "colour temperature meter",
    "kelvin meter",
    "brightness meter",
    "photography light meter",
    "incident light meter",
    "white balance check",
  ],
  input: "application/json",
  output: "application/json",
  requires: ["camera"],
  privacyNote:
    "Camera frames are analyzed in the page and discarded; nothing is recorded or uploaded.",
  options: [
    {
      kind: "number",
      id: "calibration",
      label: "Calibration factor",
      default: 1,
      min: 0.1,
      max: 10,
      step: 0.1,
    },
    {
      kind: "select",
      id: "units",
      label: "Units",
      default: "lux",
      options: [
        { value: "lux", label: "Lux", synonyms: ["lx", "metric", "SI unit"] },
        {
          value: "footcandles",
          label: "Footcandles",
          synonyms: ["fc", "foot candles", "imperial", "foot-candle"],
        },
      ],
    },
  ],
  copy: {
    what: "Turns your camera into a rough light meter. It reads the average brightness and color of the live preview and estimates illuminance in lux (or footcandles) along with a correlated color temperature in Kelvin. When your browser exposes the camera's exposure time, ISO, and aperture it uses the same incident-light formula a handheld meter uses; otherwise it falls back to a brightness-only estimate you can calibrate against a known light source.",
    how: "Press Start above to turn on your camera and point it at the light you want to measure. The lux reading, its confidence, and the estimated color temperature update live from a smoothed average of recent frames. If the reading looks off, adjust the Calibration option while pointed at a light source of known brightness until it matches.",
    why: "Dedicated lux meter apps are usually locked behind an app store install, an account, or ads, and most never explain how the number was actually computed. This page runs the same computation in the open, entirely in your browser: the camera stream is analyzed on this page and discarded, nothing is recorded or uploaded, and the exact formula is shown in the results.",
    faq: [
      {
        q: "How accurate is this light meter?",
        a: "It is an estimate, not a calibrated instrument. A phone or webcam sensor was built for pictures, not photometry, and most browsers do not expose the camera's real exposure settings, which forces a rough brightness-only fallback with roughly plus or minus 50 percent error. When exposure settings are available the estimate is tighter, roughly plus or minus 30 percent, but still not lab grade. Calibrate the Calibration option against a light source of known brightness (another meter, or a lamp's spec sheet) to improve the rough estimate for your specific camera.",
      },
      {
        q: "Why does the reading change when I move the camera or my hand?",
        a: "Your camera runs auto exposure and auto white balance continuously, so pointing it at a brighter area, a shadow, or a strongly colored surface changes what the sensor reports even if the room light has not changed. Hold the camera steady on the surface you actually want to measure, give it a second to settle, and read the smoothed value rather than any single instantaneous spike.",
      },
      {
        q: "Is my camera video uploaded anywhere?",
        a: "No. The video stream never leaves your device. Every frame is sampled and averaged locally in the page, the resulting numbers are what get analyzed, and nothing is recorded, saved, or sent to a server. Closing the tab or pressing Stop ends the camera stream immediately.",
      },
    ],
  },
};
