import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "keycode",
  icon: "Keyboard",
  name: "Keycode Info",
  description:
    "Show a live readout of every keyboard event field: key, code, legacy keyCode, active modifiers, location, and repeat state.",
  category: "Testers",
  keywords: [
    "keycode",
    "javascript keycode",
    "key event tester",
    "which vs keycode",
    "keyboard event tester",
    "key code lookup",
    "event.key event.code",
  ],
  searchTerms: [
    "keydown event tester",
    "keyboard shortcut tester",
    "key event decoder",
    "javascript key event",
    "keycode lookup table",
    "event.key reference",
    "modifier key checker",
    "shortcut combo tester",
    "which key was pressed",
    "js keyboard event inspector",
  ],
  input: "application/json",
  output: "application/json",
  copy: {
    what: "Shows what your browser really reports for a key press. Focus the capture pad, press any key or combination, and you get key, code, the legacy numeric keyCode and which, the active modifiers, the key location (standard, left, right, or numpad), whether the event is an auto-repeat, and a shortcut-style summary such as Ctrl+Shift+K. The last five distinct keys stay on screen as chips, so you can compare left Shift against right Shift, or a numpad digit against the row above it.",
    how: "Click the capture pad or tab to it, then press the key you want to inspect. While the pad has focus it swallows Tab, Space, and the arrow keys so you can read them instead of moving the page; press Escape or click away to hand those keys back to the browser. Click any recent-key chip to bring its readout back, and copy an individual field or the whole record with the buttons on the output.",
    why: "The usual keycode reference sites wrap a one-line readout in ad slots and only tell you the deprecated numeric code. This one reports the modern key and code fields alongside the legacy numbers, keeps a short history so you can compare two physical keys, runs entirely in your browser, and works offline after first load.",
    faq: [
      {
        q: "Why use event.code instead of event.keyCode?",
        a: "keyCode and which are deprecated legacy numbers that vary by layout and browser. code identifies the physical key position, so it is the same on QWERTY and AZERTY, and key gives the character actually produced. Modern code should read those two and treat the numbers as legacy only.",
      },
      {
        q: "What do the location values mean?",
        a: "They are the DOM_KEY_LOCATION constants: 0 is the standard part of the keyboard, 1 and 2 are the left and right copies of a duplicated key such as Shift or Control, and 3 is the numeric keypad. It is how you tell left Alt from right Alt.",
      },
      {
        q: "Why does one key press show as several events with Repeat set to yes?",
        a: "Holding a key down makes the browser fire keydown over and over at the operating system repeat rate. Every event after the first has repeat set to true, which is the flag to check when you want an action to run once per press rather than once per tick.",
      },
    ],
  },
};
