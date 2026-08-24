import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "key-rollover-tester",
  matrixSlug: "rollover",
  icon: "KeyboardMusic",
  name: "Key Rollover Tester",
  description:
    "Check N-key rollover and ghosting visually by holding down keys and watching a live diagram.",
  category: "Testers",
  keywords: [
    "key rollover test",
    "nkro test",
    "n-key rollover tester",
    "keyboard ghosting test",
    "6kro test",
    "anti ghosting test",
  ],
  searchTerms: [
    "how many keys can my keyboard register",
    "ghosting test",
    "usb boot protocol limit",
    "gaming keyboard test",
    "simultaneous keypress test",
    "keyboard matrix test",
    "nkro test",
    "6kro test",
  ],
  input: "application/json",
  output: "application/json",
  copy: {
    what: "Tests how many keys your keyboard can register at once, known as N-key rollover, and helps you spot ghosting and blocking while it happens. Hold down as many keys as you can and watch the count of simultaneously held keys climb, along with a live verdict: 2KRO or blocked, limited, 6KRO, or full NKRO.",
    how: "Click into the panel and hold down keys, ideally in combinations you would actually use, like a movement cluster plus a modifier plus a letter. The diagram lights up each key as it is detected, the counter tracks the largest chord seen so far, and the verdict updates live. Reset and try a different combination to map out where your keyboard's limit sits.",
    why: "Most rollover testers are Flash relics or ad-choked pages that only show a single static grid. This one runs entirely in your browser, updates the verdict live as you press, and never sends a single keystroke anywhere: your inputs never leave your device.",
    faq: [
      {
        q: "Why does the test often stop registering new keys at 6?",
        a: "Many keyboards fall back to the USB HID boot protocol, a legacy compatibility mode (also used by PC BIOS and boot loaders) that can only report up to 6 regular keys held at once plus modifiers. A keyboard advertised as NKRO usually needs a different USB report mode, sometimes toggled by a driver or a key combo, to go past this.",
      },
      {
        q: "What is the difference between ghosting and blocking?",
        a: "Blocking is a key you are pressing simply failing to register, which is safe: you just do not get that keystroke. Ghosting is a key lighting up that you never touched, caused by the keyboard's internal wiring matrix being unable to distinguish your combination from a different one that includes it. Cheaper keyboards without diode protection on every key are the most prone to ghosting.",
      },
      {
        q: "Why do some keys never register at all, like Windows+L?",
        a: "Your operating system and browser intercept certain combinations before any web page can see them, for security or system-level shortcuts: Windows+L locks the screen, Ctrl+Alt+Delete opens the OS security screen, and Alt+Tab switches windows. Those never reach this test, or any web page, regardless of your keyboard's rollover capability.",
      },
    ],
  },
};
