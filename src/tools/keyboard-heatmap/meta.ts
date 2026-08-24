import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "keyboard-heatmap",
  matrixSlug: "heatmap",
  icon: "Keyboard",
  name: "Keyboard Layout Heatmap",
  description: "Key and finger load for any text, across keyboard layouts.",
  category: "Testers",
  keywords: [
    "keyboard heatmap",
    "keyboard layout analyzer",
    "qwerty vs dvorak vs colemak",
    "typing finger load",
    "colemak dh analysis",
    "keyboard layout comparison",
  ],
  searchTerms: [
    "same finger bigram calculator",
    "sfb percentage",
    "home row usage",
    "finger travel distance typing",
    "workman layout analyzer",
    "graphite layout stats",
    "halmak",
    "azerty qwertz analysis",
    "typing effort score",
    "which keyboard layout is best for me",
    "keyboard heatmap generator",
    "typing heatmap",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "layout",
      label: "Layout",
      default: "qwerty",
      groups: [
        {
          label: "Standard",
          synonyms: ["default", "normal", "stock", "us english"],
          options: [
            {
              value: "qwerty",
              label: "QWERTY",
              synonyms: ["standard", "default", "us", "normal keyboard"],
            },
          ],
        },
        {
          label: "Alternative",
          synonyms: ["ergonomic", "optimized", "alt layouts", "efficient layouts"],
          options: [
            {
              value: "dvorak",
              label: "Dvorak",
              synonyms: ["simplified keyboard", "dsk", "august dvorak"],
            },
            {
              value: "colemak",
              label: "Colemak",
              synonyms: ["cmk", "shai coleman"],
            },
            {
              value: "colemak-dh",
              label: "Colemak-DH",
              synonyms: ["colemak dh", "mod dh", "mod-dh", "curl dh", "cmk dh"],
            },
            {
              value: "workman",
              label: "Workman",
              synonyms: ["workman layout", "oj bucao"],
            },
            {
              value: "norman",
              label: "Norman",
              synonyms: ["norman layout", "david norman"],
            },
            {
              value: "halmak",
              label: "Halmak",
              synonyms: ["halmak 2.2", "genetic layout", "ai keyboard layout"],
            },
            {
              value: "graphite",
              label: "Graphite",
              synonyms: ["graphite layout", "oxeylyzer", "sturdy family"],
            },
          ],
        },
        {
          label: "Regional",
          synonyms: ["international", "european", "non english", "localized"],
          options: [
            {
              value: "azerty",
              label: "AZERTY (French)",
              synonyms: ["french keyboard", "france", "azerty fr"],
            },
            {
              value: "qwertz",
              label: "QWERTZ (German)",
              synonyms: ["german keyboard", "germany", "austria", "swiss"],
            },
          ],
        },
      ],
    },
    {
      kind: "select",
      id: "mode",
      label: "Mode",
      default: "analyze",
      options: [
        {
          value: "analyze",
          label: "Analyze one layout",
          synonyms: ["single", "heatmap", "one layout", "stats"],
        },
        {
          value: "compare",
          label: "Compare every layout",
          synonyms: ["rank", "ranking", "table", "all layouts", "versus", "vs"],
        },
      ],
    },
  ],
  http: { method: "POST", contentType: "application/json" },
  copy: {
    what: "Counts how a piece of text would actually be typed on ten keyboard layouts. Paste your writing, your code, or a chat log and you get per key press counts, load on each of the eight fingers, hand balance, home row usage, same finger bigrams, hand alternation, inward and outward rolls, an effort score per 100 keystrokes, and how far your fingers travel in key units. Compare mode runs the same text through QWERTY, Dvorak, Colemak, Colemak-DH, Workman, Norman, Halmak, Graphite, AZERTY, and QWERTZ, then ranks them by effort.",
    how: "Paste or drop text into the input, pick a layout, and read the rows. Switch Mode to compare to see every layout ranked against each other on your own text instead of a generic English corpus. Matching is case insensitive and shifted symbols count as a press of the key that carries them, so pasting real prose or real source code both work. Spaces, tabs, and line breaks are counted separately because the space bar is a thumb key.",
    why: "The well known layout analyzer sites are a decade old, ask you to pick from a fixed corpus, and stop at QWERTY, Dvorak, and Colemak. This one takes your text, covers Colemak-DH, Workman, Norman, Halmak, and Graphite as well, publishes the exact effort weights it uses instead of hiding them, and runs entirely in the page so your files and inputs never leave your device.",
    faq: [
      {
        q: "What do same finger bigrams and rolls actually mean?",
        a: 'A same finger bigram, usually shortened to SFB, is two letters in a row that the same finger has to press, like the d and the e in QWERTY "ed". The finger has to lift and move, so it is the main thing that caps typing speed. A roll is the opposite: two letters in a row on the same hand but different fingers, so the fingers can fall like a drum roll. Inward rolls run from the pinky toward the index finger and are usually the comfortable direction. Alternation is when a pair swaps hands entirely, which gives each hand a moment to reset. Lower SFB with higher rolls and alternation is what most layout designers aim for.',
      },
      {
        q: "Is QWERTY really as bad as people say?",
        a: "On ordinary English prose this tool puts QWERTY near the bottom of the ten layouts, mostly on home row usage: roughly 35 percent of keystrokes stay on the home row against roughly 70 percent on Colemak or Workman, with about five times the same finger bigrams. That is a real gap, but it is a gap in comfort metrics, not proof that you will type faster. Plenty of fast typists use QWERTY, retraining costs weeks, and the effort score here is a simple weighted model rather than a measurement of your hands. Run your own text through compare mode and treat the numbers as one input to the decision, not the decision.",
      },
      {
        q: "Is my text sent anywhere?",
        a: "No. The whole analysis runs in your browser, and the page keeps working offline after the first load. Nothing you paste is uploaded, logged, or stored.",
      },
    ],
  },
};
