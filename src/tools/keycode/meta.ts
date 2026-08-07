import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'keycode',
  icon: 'Keyboard',
  name: 'Keycode Info',
  description: 'Live key, code, keyCode and modifier readout.',
  category: 'Testers',
  keywords: [
    'keycode',
    'javascript keycode',
    'key event tester',
    'which vs keycode',
    'keyboard event tester',
    'key code lookup',
    'event.key event.code',
  ],
  searchTerms: [
    'keydown event tester',
    'keyboard shortcut tester',
    'key event decoder',
    'javascript key event',
    'keycode lookup table',
    'event.key reference',
    'modifier key checker',
    'shortcut combo tester',
  ],
  input: 'application/json',
  output: 'application/json',
  copy: {
    what: 'Decodes a keyboard event into every field developers actually need: key, code, the legacy numeric keyCode and which, active modifiers, key location (standard/left/right/numpad), repeat state, and a shortcut-style summary like Ctrl+Shift+K. Paste the serialized event fields as JSON and get a labeled breakdown.',
    how: 'In a browser console, log the fields off a keydown listener, e.g. `document.addEventListener("keydown", e => console.log(JSON.stringify({key:e.key,code:e.code,keyCode:e.keyCode,which:e.which,shiftKey:e.shiftKey,ctrlKey:e.ctrlKey,altKey:e.altKey,metaKey:e.metaKey,repeat:e.repeat,location:e.location})))`, then paste the JSON output here to see it decoded. Missing fields are fine; unrecognized ones are ignored.',
    why: 'Most keycode reference sites only show a live "press a key" demo with no way to inspect an event you already captured, and bury it in ads. This one parses the raw event JSON directly, works offline, and never sends your input anywhere.',
    faq: [
      {
        q: 'Why use event.code instead of event.keyCode?',
        a: 'keyCode and which are deprecated legacy numeric codes that vary by layout and browser. code identifies the physical key position (layout-independent) and key gives the character actually produced: modern code should read those instead.',
      },
      {
        q: 'What do the location values mean?',
        a: 'DOM_KEY_LOCATION: 0 is the standard part of the keyboard, 1 and 2 are the left/right variants of duplicated keys like Shift or Ctrl, and 3 is the numeric keypad.',
      },
      {
        q: 'Can I capture a live keypress here instead of pasting JSON?',
        a: 'Not yet on this page: it decodes event data you already have. A live capture panel that listens for keydown/keyup directly is planned as a richer view of the same logic.',
      },
    ],
  },
};
