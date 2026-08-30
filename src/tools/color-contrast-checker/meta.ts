import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "color-contrast-checker",
  icon: "Eye",
  name: "Color Contrast Checker",
  description:
    "Check a foreground and background pair against WCAG 2.x contrast ratios and the APCA Lc scale.",
  category: "Color",
  keywords: [
    "color contrast checker",
    "wcag contrast ratio",
    "aa aaa contrast test",
    "apca contrast calculator",
    "accessible text color",
    "contrast ratio calculator",
    "is this color accessible",
    "fix failing contrast",
  ],
  searchTerms: [
    "colour contrast checker",
    "wcag 2.1 1.4.3",
    "large text contrast",
    "non text contrast 1.4.11",
    "lc value",
    "wcag 3 contrast",
    "oklch accessible palette",
    "text on background readable",
    "a11y color check",
  ],
  input: "text/plain",
  output: "application/json",
  inputOptional: {
    label: "Quick entry",
    hint: 'Type a whole pair at once, like "#333 on #fff", and it fills both boxes.',
  },
  options: [
    {
      kind: "text",
      id: "foreground",
      label: "Foreground",
      default: "#5b4bd6",
      placeholder: "#5b4bd6",
    },
    {
      kind: "text",
      id: "background",
      label: "Background",
      default: "#ffffff",
      placeholder: "#ffffff",
    },
    {
      kind: "select",
      id: "target",
      label: "Target level",
      default: "aa-normal",
      options: [
        {
          value: "aa-normal",
          label: "AA normal text (4.5:1)",
          synonyms: ["aa", "body text", "4.5", "minimum", "1.4.3"],
        },
        {
          value: "aa-large",
          label: "AA large text (3:1)",
          synonyms: ["aa large", "heading", "3:1", "18pt", "14pt bold"],
        },
        {
          value: "aa-ui",
          label: "AA user interface (3:1)",
          synonyms: ["non text", "icon", "border", "focus ring", "1.4.11"],
        },
        {
          value: "aaa-normal",
          label: "AAA normal text (7:1)",
          synonyms: ["aaa", "enhanced", "7:1", "1.4.6"],
        },
        {
          value: "aaa-large",
          label: "AAA large text (4.5:1)",
          synonyms: ["aaa large", "enhanced heading", "4.5"],
        },
      ],
    },
  ],
  examples: [
    {
      label: "A brand violet on paper white",
      input: "#5b4bd6 on #f6f4f1",
      opts: { target: "aa-normal" },
    },
    {
      label: "Gray text that just misses AA",
      input: "#777777 on #ffffff",
      opts: { target: "aa-normal" },
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Measures the contrast between a text color and the surface behind it, and reports both models people are asked for: the WCAG 2.x ratio with a pass or fail against AA and AAA for normal text, large text, and user interface elements, and the APCA Lc value with the size and weight guidance that goes with it. Both colors accept any CSS syntax, including hex, rgb(), hsl(), hwb(), lab(), lch(), oklab(), oklch(), and all 148 color names. When a pair fails, it works out the nearest foreground that passes by moving lightness in OKLCH while holding hue and chroma, so the suggestion still looks like your brand color.",
    how: 'Type or paste the two colors into the foreground and background boxes, or use the quick entry field for a whole pair at once, like "#333 on #fff". Pick the target level you actually have to hit, which decides what the suggestion aims at. A translucent color is flattened before it is measured, the foreground over the background and the background over white, and the report says when that happened. Every row has a copy button, and the pair round trips through the URL, so a shared link reopens the exact check.',
    why: "The well known checkers give you one number and stop. This one gives you the ratio, every level it does and does not clear, the APCA value that WCAG 3 is being drafted around, and, when you fail, an actual color to use instead rather than a red cross. It reads modern CSS color syntax that older tools reject outright, and your inputs never leave your device, with no ads and no daily limit.",
    faq: [
      {
        q: "Why do WCAG and APCA disagree about my colors?",
        a: "They model different things. The WCAG 2.x ratio compares relative luminance with a fixed 0.05 offset, which flattens the difference between dark colors and overstates it between light ones. APCA models perceived lightness contrast and takes polarity into account, so dark text on light and light text on dark score differently even at the same ratio. Dark themes are where they disagree most: a pair that clears AA can be genuinely hard to read, and a pair that fails AA can be fine.",
      },
      {
        q: "What counts as large text?",
        a: "WCAG defines large as 18pt and up, or 14pt and up when the text is bold, which is roughly 24px and 18.66px at the usual browser default. Large text only needs 3:1 for AA and 4.5:1 for AAA. Icons, input borders, focus rings, and other non text parts of the interface are covered by a separate rule and need 3:1 against what is next to them.",
      },
      {
        q: "How is the suggested color chosen?",
        a: "It converts your foreground to OKLCH, then searches for the smallest change in lightness, up or down, that reaches the target, holding hue and chroma fixed so the color still reads as the same color. Any chroma that no longer fits inside sRGB at the new lightness is reduced until it does. The search runs on the color rounded to eight bits per channel, so the hex you are given genuinely passes rather than passing only in floating point.",
      },
    ],
  },
};
