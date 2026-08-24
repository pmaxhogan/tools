import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "oryx-layout-diff",
  icon: "LayoutGrid",
  matrixSlug: "oryx-diff",
  name: "Oryx Layout Differ",
  description: "Diff two ZSA Moonlander layouts key by key from their keymap.c files.",
  category: "Testers",
  keywords: [
    "oryx layout diff",
    "compare moonlander layouts",
    "zsa keymap diff",
    "qmk keymap compare",
    "moonlander layout changes",
    "keymap.c diff tool",
    "oryx revision compare",
  ],
  searchTerms: [
    "zsa moonlander",
    "keyboard layout diff",
    "keymap comparison",
    "qmk layout compare",
    "keyboard firmware diff",
    "layer diff tool",
    "moonlander revision history",
    "compare keymaps",
    "keyboard config diff",
    "oryx configurator diff",
    "keymap.c compare",
    "what changed in my keymap",
    "moonlander base layer diff",
  ],
  input: "text/plain",
  output: "text/plain",
  options: [
    {
      kind: "boolean",
      id: "showUnchanged",
      label: "Show unchanged keys",
      default: false,
    },
    {
      kind: "select",
      id: "format",
      label: "Output format",
      default: "report",
      options: [
        {
          value: "report",
          label: "Readable report",
          synonyms: ["human readable", "text report", "summary"],
        },
        {
          value: "csv",
          label: "CSV (position, layer, old, new)",
          synonyms: ["comma separated values", "spreadsheet", "export csv"],
        },
      ],
    },
  ],
  examples: [
    {
      label: "Base layer revision",
      input:
        "#include QMK_KEYBOARD_H\n\nenum layers { BASE };\n\nconst uint16_t PROGMEM keymaps[][MATRIX_ROWS][MATRIX_COLS] = {\n  [BASE] = LAYOUT_moonlander(KC_EQUAL, KC_1, KC_2, KC_3, KC_4, KC_5, KC_LEFT, KC_RIGHT, KC_6, KC_7, KC_8, KC_9, KC_0, KC_MINUS, KC_DELETE, KC_Q, KC_W, KC_E, KC_R, KC_T, KC_LBRC, KC_RBRC, KC_Y, KC_U, KC_I, KC_O, KC_P, KC_BSLS, KC_BSPC, KC_A, KC_S, KC_D, KC_F, KC_G, KC_LGUI, MT(MOD_LSFT, KC_ESCAPE), KC_H, KC_J, KC_K, KC_L, KC_SCLN, KC_QUOTE, KC_LSFT, KC_Z, KC_X, KC_C, KC_V, KC_B, KC_N, KC_M, KC_COMMA, KC_DOT, KC_SLASH, KC_RSFT, KC_LCTL, KC_GRAVE, KC_LALT, KC_HOME, KC_END, LT(1, KC_SPACE), MO(1), KC_UP, KC_DOWN, KC_PGUP, KC_PGDN, KC_RGUI, KC_TAB, KC_CAPS, KC_ENTER, KC_BSPC, KC_DELETE, RGB_TOG),\n};\n\n=====\n#include QMK_KEYBOARD_H\n\nenum layers { BASE };\n\nconst uint16_t PROGMEM keymaps[][MATRIX_ROWS][MATRIX_COLS] = {\n  [BASE] = LAYOUT_moonlander(KC_EQUAL, KC_1, KC_2, KC_3, KC_4, KC_5, KC_LEFT, KC_RIGHT, KC_6, KC_7, KC_8, KC_9, KC_0, KC_MINUS, KC_DELETE, KC_Q, KC_W, KC_E, KC_R, KC_T, KC_LBRC, KC_RBRC, KC_Y, KC_U, KC_I, KC_O, KC_P, KC_BSLS, KC_BSPC, KC_A, KC_S, KC_D, KC_F, KC_G, MT(MOD_LGUI, KC_TAB), MT(MOD_LSFT, KC_ESCAPE), KC_H, KC_J, KC_K, KC_L, KC_SCLN, KC_QUOTE, KC_LSFT, KC_Z, KC_X, KC_C, KC_V, KC_B, KC_N, KC_M, KC_COMMA, KC_DOT, KC_SLASH, KC_RSFT, KC_LCTL, KC_GRAVE, KC_LALT, KC_HOME, KC_END, LT(1, KC_SPACE), MO(1), KC_UP, KC_DOWN, KC_PGUP, KC_PGDN, KC_MUTE, KC_TAB, KC_ESCAPE, KC_ENTER, KC_BSPC, KC_DELETE, RGB_TOG),\n};\n",
      opts: { showUnchanged: "false", format: "report" },
    },
  ],
  copy: {
    what: "Compares two revisions of a ZSA Moonlander layout and lists every key that changed, layer by layer. It reads the keymap.c file from the Download Source zip that Oryx gives you, parses the LAYOUT macros (including nested keycodes like LT(1, KC_SPC) and MT(MOD_LSFT, KC_ESC)), and names each changed key by where it physically sits: which hand, which row, which column and which finger zone. Layer names come from the layers enum in the file when it has one. It also reports layers added or removed between the two revisions, and spots bindings that moved from one key to another on the same layer.",
    how: 'In Oryx, open each revision of your layout and use Download Source to get its zip, then open keymap.c from each one. Paste the older keymap.c into the box, add a line containing only =====, then paste the newer keymap.c below it. The report shows changed keys per layer with old and new names; switch on "Show unchanged keys" for the full picture of every key, or pick CSV to get position, layer, old and new columns you can drop into a spreadsheet.',
    why: "Oryx has no layout diff, so comparing revisions means opening two browser tabs and eyeballing the configurator key by key until something looks off. This reads the keymap.c you already export and names every changed key by its physical position, so a review takes seconds instead of a squinting session. It runs entirely in your browser: your files and inputs never leave your device.",
    faq: [
      {
        q: "Where do I get the keymap.c file?",
        a: "In Oryx, open the layout, click Download Source, and unzip what it hands you. keymap.c is in there, and it is the only offline export Oryx offers that contains the actual key assignments. Do this for both revisions you want to compare and paste the two files in, separated by a line of five equals signs.",
      },
      {
        q: "Does this work for the ZSA Voyager or the ErgoDox EZ?",
        a: "Not yet, honestly. The parser reads any QMK LAYOUT macro, so a Voyager or ErgoDox keymap.c will still be diffed and you will still see which keys changed, but only the Moonlander physical map (72 keys per layer) ships with the tool. Layers with a different key count are reported by key index instead of hand, row and column, and the tool says so in a warning.",
      },
      {
        q: "Is my layout uploaded anywhere?",
        a: "No. The parser and the diff both run in your browser, and your files and inputs never leave your device. Nothing is sent to ZSA, to this site, or anywhere else, so you can compare a work layout without thinking twice about it.",
      },
    ],
  },
};
