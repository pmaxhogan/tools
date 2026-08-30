import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "gamepad-tester",
  matrixSlug: "gamepad",
  icon: "Gamepad2",
  name: "Gamepad Tester",
  description:
    "Test every button, trigger, and analog stick on a connected gamepad, and quantify analog stick drift precisely.",
  category: "Testers",
  keywords: [
    "gamepad tester",
    "controller tester online",
    "joystick drift test",
    "stick drift checker",
    "xbox controller test",
    "ps5 controller test browser",
    "gamepad api test",
  ],
  searchTerms: [
    "controller not working test",
    "analog stick drift",
    "dualsense drift test",
    "switch pro controller test",
    "button mapping tester",
    "trigger not reaching full range",
    "vibration test controller",
  ],
  input: "application/json",
  output: "application/json",
  options: [
    {
      kind: "number",
      id: "deadzone",
      label: "Deadzone",
      default: 0.05,
      min: 0,
      max: 0.3,
      step: 0.01,
    },
    {
      kind: "select",
      id: "labels",
      label: "Button labels",
      default: "auto",
      options: [
        {
          value: "auto",
          label: "Auto detect",
          synonyms: ["automatic", "guess", "detect from id"],
        },
        {
          value: "xbox",
          label: "Xbox (A/B/X/Y)",
          synonyms: ["microsoft", "xinput", "a b x y"],
        },
        {
          value: "playstation",
          label: "PlayStation (Cross/Circle/Square/Triangle)",
          synonyms: ["ps5", "ps4", "dualsense", "dualshock", "sony"],
        },
        {
          value: "switch",
          label: "Nintendo Switch (B/A/Y/X)",
          synonyms: ["nintendo", "pro controller", "joy-con"],
        },
        {
          value: "generic",
          label: "Generic (numbered)",
          synonyms: ["numbers", "button index", "unlabeled"],
        },
      ],
    },
  ],
  copy: {
    what: "Tests every button, trigger, and analog stick on a connected gamepad or controller, and quantifies analog stick drift, the resting offset that keeps a character creeping even when you are not touching the stick. It reads Xbox, PlayStation, Nintendo Switch, and generic controllers through the browser's Gamepad API, live in a diagram of buttons and stick position, no drivers or downloads.",
    how: "Connect your controller, then press any button on it: browsers only expose a gamepad to a page after you interact with one. Watch the buttons and stick crosshairs light up as you press and move them, run the deadzone test by leaving a stick untouched for a few seconds, and rotate a stick through a full circle to check how round its range of motion actually is.",
    why: "Most gamepad testers online are single-purpose demo pages that show raw button numbers and stop there. This one adds an actual drift measurement with a suggested deadzone, a circularity check for worn sticks, and vendor-correct button names instead of just indices, and it never sends a single input anywhere: your files and inputs never leave your device.",
    faq: [
      {
        q: "Why does nothing show up until I press a button?",
        a: "Browsers do not let a page see connected gamepads until you interact with one, as a privacy and fingerprinting protection. Plug in your controller, press any button or move a stick, and the page will pick it up immediately.",
      },
      {
        q: "What deadzone should I set?",
        a: "Run the drift test with the stick at rest: it reports a suggested deadzone that covers the observed offset with a small margin. Most controllers are fine between 0.05 and 0.1; a healthy stick with no drift can use a smaller deadzone, while a worn one needs a larger one to stop unwanted movement.",
      },
      {
        q: "Can this tool fix my stick drift?",
        a: "No. It measures drift so you know how bad it is and what deadzone would compensate for it in games that let you set one, but it cannot repair worn potentiometers or clean debris out of a stick module. Physical cleaning, a controller repair, or a manufacturer replacement are the actual fixes.",
      },
    ],
  },
};
