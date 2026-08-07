/**
 * Static data for the oryx-layout-diff tool: the ZSA Moonlander physical
 * geometry and a curated QMK keycode name table.
 *
 * MOONLANDER_POSITIONS is derived from the QMK firmware layout definition at
 * keyboards/zsa/moonlander/keyboard.json (the LAYOUT macro, 72 entries). Each
 * entry maps a keymap.c token index to where that key physically sits: hand,
 * row, column and finger zone. Columns are numbered from the outer edge of
 * each hand inward, so col 1 is the outer pinky column on both hands.
 * Rows 1 to 5 are the main key rows, top to bottom. Row 6 is the thumb
 * cluster: thumb 1 is the large key, thumbs 2 to 4 run outward to inward.
 *
 * The geometry is fixed hardware, so it ships as static data. Nothing here is
 * fetched at runtime.
 */

export interface KeyPosition {
  /** Position of this key in the LAYOUT(...) argument list, 0 to 71. */
  index: number;
  hand: 'left' | 'right';
  /** 'main' for the five key rows, 'thumb' for the thumb cluster. */
  zone: 'main' | 'thumb';
  /** 1 to 5 for the main rows, 6 for every thumb key. */
  row: number;
  /** Column within the hand, counted from the outer edge inward. */
  col: number;
  /** Finger zone label, or 'thumb'. */
  finger: string;
  /** Human descriptor used in the report, e.g. 'Left hand, row 2, col 3 (ring)'. */
  label: string;
}

/** Every key position on a Moonlander, in keymap.c token order. */
export const MOONLANDER_POSITIONS: readonly KeyPosition[] = [
  { index: 0, hand: 'left', zone: 'main', row: 1, col: 1, finger: 'pinky outer', label: 'Left hand, row 1, col 1 (pinky outer)' },
  { index: 1, hand: 'left', zone: 'main', row: 1, col: 2, finger: 'pinky', label: 'Left hand, row 1, col 2 (pinky)' },
  { index: 2, hand: 'left', zone: 'main', row: 1, col: 3, finger: 'ring', label: 'Left hand, row 1, col 3 (ring)' },
  { index: 3, hand: 'left', zone: 'main', row: 1, col: 4, finger: 'middle', label: 'Left hand, row 1, col 4 (middle)' },
  { index: 4, hand: 'left', zone: 'main', row: 1, col: 5, finger: 'index', label: 'Left hand, row 1, col 5 (index)' },
  { index: 5, hand: 'left', zone: 'main', row: 1, col: 6, finger: 'index inner', label: 'Left hand, row 1, col 6 (index inner)' },
  { index: 6, hand: 'left', zone: 'main', row: 1, col: 7, finger: 'inner column', label: 'Left hand, row 1, col 7 (inner column)' },
  { index: 7, hand: 'right', zone: 'main', row: 1, col: 7, finger: 'inner column', label: 'Right hand, row 1, col 7 (inner column)' },
  { index: 8, hand: 'right', zone: 'main', row: 1, col: 6, finger: 'index inner', label: 'Right hand, row 1, col 6 (index inner)' },
  { index: 9, hand: 'right', zone: 'main', row: 1, col: 5, finger: 'index', label: 'Right hand, row 1, col 5 (index)' },
  { index: 10, hand: 'right', zone: 'main', row: 1, col: 4, finger: 'middle', label: 'Right hand, row 1, col 4 (middle)' },
  { index: 11, hand: 'right', zone: 'main', row: 1, col: 3, finger: 'ring', label: 'Right hand, row 1, col 3 (ring)' },
  { index: 12, hand: 'right', zone: 'main', row: 1, col: 2, finger: 'pinky', label: 'Right hand, row 1, col 2 (pinky)' },
  { index: 13, hand: 'right', zone: 'main', row: 1, col: 1, finger: 'pinky outer', label: 'Right hand, row 1, col 1 (pinky outer)' },
  { index: 14, hand: 'left', zone: 'main', row: 2, col: 1, finger: 'pinky outer', label: 'Left hand, row 2, col 1 (pinky outer)' },
  { index: 15, hand: 'left', zone: 'main', row: 2, col: 2, finger: 'pinky', label: 'Left hand, row 2, col 2 (pinky)' },
  { index: 16, hand: 'left', zone: 'main', row: 2, col: 3, finger: 'ring', label: 'Left hand, row 2, col 3 (ring)' },
  { index: 17, hand: 'left', zone: 'main', row: 2, col: 4, finger: 'middle', label: 'Left hand, row 2, col 4 (middle)' },
  { index: 18, hand: 'left', zone: 'main', row: 2, col: 5, finger: 'index', label: 'Left hand, row 2, col 5 (index)' },
  { index: 19, hand: 'left', zone: 'main', row: 2, col: 6, finger: 'index inner', label: 'Left hand, row 2, col 6 (index inner)' },
  { index: 20, hand: 'left', zone: 'main', row: 2, col: 7, finger: 'inner column', label: 'Left hand, row 2, col 7 (inner column)' },
  { index: 21, hand: 'right', zone: 'main', row: 2, col: 7, finger: 'inner column', label: 'Right hand, row 2, col 7 (inner column)' },
  { index: 22, hand: 'right', zone: 'main', row: 2, col: 6, finger: 'index inner', label: 'Right hand, row 2, col 6 (index inner)' },
  { index: 23, hand: 'right', zone: 'main', row: 2, col: 5, finger: 'index', label: 'Right hand, row 2, col 5 (index)' },
  { index: 24, hand: 'right', zone: 'main', row: 2, col: 4, finger: 'middle', label: 'Right hand, row 2, col 4 (middle)' },
  { index: 25, hand: 'right', zone: 'main', row: 2, col: 3, finger: 'ring', label: 'Right hand, row 2, col 3 (ring)' },
  { index: 26, hand: 'right', zone: 'main', row: 2, col: 2, finger: 'pinky', label: 'Right hand, row 2, col 2 (pinky)' },
  { index: 27, hand: 'right', zone: 'main', row: 2, col: 1, finger: 'pinky outer', label: 'Right hand, row 2, col 1 (pinky outer)' },
  { index: 28, hand: 'left', zone: 'main', row: 3, col: 1, finger: 'pinky outer', label: 'Left hand, row 3, col 1 (pinky outer)' },
  { index: 29, hand: 'left', zone: 'main', row: 3, col: 2, finger: 'pinky', label: 'Left hand, row 3, col 2 (pinky)' },
  { index: 30, hand: 'left', zone: 'main', row: 3, col: 3, finger: 'ring', label: 'Left hand, row 3, col 3 (ring)' },
  { index: 31, hand: 'left', zone: 'main', row: 3, col: 4, finger: 'middle', label: 'Left hand, row 3, col 4 (middle)' },
  { index: 32, hand: 'left', zone: 'main', row: 3, col: 5, finger: 'index', label: 'Left hand, row 3, col 5 (index)' },
  { index: 33, hand: 'left', zone: 'main', row: 3, col: 6, finger: 'index inner', label: 'Left hand, row 3, col 6 (index inner)' },
  { index: 34, hand: 'left', zone: 'main', row: 3, col: 7, finger: 'inner column', label: 'Left hand, row 3, col 7 (inner column)' },
  { index: 35, hand: 'right', zone: 'main', row: 3, col: 7, finger: 'inner column', label: 'Right hand, row 3, col 7 (inner column)' },
  { index: 36, hand: 'right', zone: 'main', row: 3, col: 6, finger: 'index inner', label: 'Right hand, row 3, col 6 (index inner)' },
  { index: 37, hand: 'right', zone: 'main', row: 3, col: 5, finger: 'index', label: 'Right hand, row 3, col 5 (index)' },
  { index: 38, hand: 'right', zone: 'main', row: 3, col: 4, finger: 'middle', label: 'Right hand, row 3, col 4 (middle)' },
  { index: 39, hand: 'right', zone: 'main', row: 3, col: 3, finger: 'ring', label: 'Right hand, row 3, col 3 (ring)' },
  { index: 40, hand: 'right', zone: 'main', row: 3, col: 2, finger: 'pinky', label: 'Right hand, row 3, col 2 (pinky)' },
  { index: 41, hand: 'right', zone: 'main', row: 3, col: 1, finger: 'pinky outer', label: 'Right hand, row 3, col 1 (pinky outer)' },
  { index: 42, hand: 'left', zone: 'main', row: 4, col: 1, finger: 'pinky outer', label: 'Left hand, row 4, col 1 (pinky outer)' },
  { index: 43, hand: 'left', zone: 'main', row: 4, col: 2, finger: 'pinky', label: 'Left hand, row 4, col 2 (pinky)' },
  { index: 44, hand: 'left', zone: 'main', row: 4, col: 3, finger: 'ring', label: 'Left hand, row 4, col 3 (ring)' },
  { index: 45, hand: 'left', zone: 'main', row: 4, col: 4, finger: 'middle', label: 'Left hand, row 4, col 4 (middle)' },
  { index: 46, hand: 'left', zone: 'main', row: 4, col: 5, finger: 'index', label: 'Left hand, row 4, col 5 (index)' },
  { index: 47, hand: 'left', zone: 'main', row: 4, col: 6, finger: 'index inner', label: 'Left hand, row 4, col 6 (index inner)' },
  { index: 48, hand: 'right', zone: 'main', row: 4, col: 6, finger: 'index inner', label: 'Right hand, row 4, col 6 (index inner)' },
  { index: 49, hand: 'right', zone: 'main', row: 4, col: 5, finger: 'index', label: 'Right hand, row 4, col 5 (index)' },
  { index: 50, hand: 'right', zone: 'main', row: 4, col: 4, finger: 'middle', label: 'Right hand, row 4, col 4 (middle)' },
  { index: 51, hand: 'right', zone: 'main', row: 4, col: 3, finger: 'ring', label: 'Right hand, row 4, col 3 (ring)' },
  { index: 52, hand: 'right', zone: 'main', row: 4, col: 2, finger: 'pinky', label: 'Right hand, row 4, col 2 (pinky)' },
  { index: 53, hand: 'right', zone: 'main', row: 4, col: 1, finger: 'pinky outer', label: 'Right hand, row 4, col 1 (pinky outer)' },
  { index: 54, hand: 'left', zone: 'main', row: 5, col: 1, finger: 'pinky outer', label: 'Left hand, row 5, col 1 (pinky outer)' },
  { index: 55, hand: 'left', zone: 'main', row: 5, col: 2, finger: 'pinky', label: 'Left hand, row 5, col 2 (pinky)' },
  { index: 56, hand: 'left', zone: 'main', row: 5, col: 3, finger: 'ring', label: 'Left hand, row 5, col 3 (ring)' },
  { index: 57, hand: 'left', zone: 'main', row: 5, col: 4, finger: 'middle', label: 'Left hand, row 5, col 4 (middle)' },
  { index: 58, hand: 'left', zone: 'main', row: 5, col: 5, finger: 'index', label: 'Left hand, row 5, col 5 (index)' },
  { index: 59, hand: 'left', zone: 'thumb', row: 6, col: 1, finger: 'thumb', label: 'Left thumb 1 (large)' },
  { index: 60, hand: 'right', zone: 'thumb', row: 6, col: 1, finger: 'thumb', label: 'Right thumb 1 (large)' },
  { index: 61, hand: 'right', zone: 'main', row: 5, col: 5, finger: 'index', label: 'Right hand, row 5, col 5 (index)' },
  { index: 62, hand: 'right', zone: 'main', row: 5, col: 4, finger: 'middle', label: 'Right hand, row 5, col 4 (middle)' },
  { index: 63, hand: 'right', zone: 'main', row: 5, col: 3, finger: 'ring', label: 'Right hand, row 5, col 3 (ring)' },
  { index: 64, hand: 'right', zone: 'main', row: 5, col: 2, finger: 'pinky', label: 'Right hand, row 5, col 2 (pinky)' },
  { index: 65, hand: 'right', zone: 'main', row: 5, col: 1, finger: 'pinky outer', label: 'Right hand, row 5, col 1 (pinky outer)' },
  { index: 66, hand: 'left', zone: 'thumb', row: 6, col: 2, finger: 'thumb', label: 'Left thumb 2' },
  { index: 67, hand: 'left', zone: 'thumb', row: 6, col: 3, finger: 'thumb', label: 'Left thumb 3' },
  { index: 68, hand: 'left', zone: 'thumb', row: 6, col: 4, finger: 'thumb', label: 'Left thumb 4' },
  { index: 69, hand: 'right', zone: 'thumb', row: 6, col: 4, finger: 'thumb', label: 'Right thumb 4' },
  { index: 70, hand: 'right', zone: 'thumb', row: 6, col: 3, finger: 'thumb', label: 'Right thumb 3' },
  { index: 71, hand: 'right', zone: 'thumb', row: 6, col: 2, finger: 'thumb', label: 'Right thumb 2' },
];

/**
 * Tokens that mean "fall through to the layer below". Oryx writes the long
 * form, hand written keymaps usually write the underscore form.
 */
export const TRANSPARENT_TOKENS: readonly string[] = ['_______', 'KC_TRNS', 'KC_TRANSPARENT'];

/** Tokens that mean "this key does nothing". */
export const NONE_TOKENS: readonly string[] = ['XXXXXXX', 'KC_NO'];

/**
 * Curated display names for keycodes whose bare name reads badly. Anything
 * not listed here falls back to stripping the KC_ prefix, so KC_A shows as A
 * and KC_F7 shows as F7 without needing a table entry.
 */
export const KEYCODE_NAMES: Readonly<Record<string, string>> = {
  // Modifiers, short and long spellings.
  KC_LSFT: 'LShift',
  KC_LEFT_SHIFT: 'LShift',
  KC_RSFT: 'RShift',
  KC_RIGHT_SHIFT: 'RShift',
  KC_LCTL: 'LCtrl',
  KC_LEFT_CTRL: 'LCtrl',
  KC_RCTL: 'RCtrl',
  KC_RIGHT_CTRL: 'RCtrl',
  KC_LALT: 'LAlt',
  KC_LEFT_ALT: 'LAlt',
  KC_RALT: 'RAlt',
  KC_RIGHT_ALT: 'RAlt',
  KC_LGUI: 'LGui',
  KC_LEFT_GUI: 'LGui',
  KC_RGUI: 'RGui',
  KC_RIGHT_GUI: 'RGui',

  // Whitespace and editing.
  KC_ENT: 'Enter',
  KC_ENTER: 'Enter',
  KC_SPC: 'Space',
  KC_SPACE: 'Space',
  KC_TAB: 'Tab',
  KC_BSPC: 'Backspace',
  KC_BACKSPACE: 'Backspace',
  KC_ESC: 'Esc',
  KC_ESCAPE: 'Esc',
  KC_DEL: 'Delete',
  KC_DELETE: 'Delete',
  KC_INS: 'Insert',
  KC_INSERT: 'Insert',
  KC_CAPS: 'CapsLock',
  KC_CAPS_LOCK: 'CapsLock',

  // Punctuation.
  KC_MINS: '-',
  KC_MINUS: '-',
  KC_EQL: '=',
  KC_EQUAL: '=',
  KC_LBRC: '[',
  KC_LEFT_BRACKET: '[',
  KC_RBRC: ']',
  KC_RIGHT_BRACKET: ']',
  KC_BSLS: '\\',
  KC_BACKSLASH: '\\',
  KC_SCLN: ';',
  KC_SEMICOLON: ';',
  KC_QUOT: "'",
  KC_QUOTE: "'",
  KC_GRV: '`',
  KC_GRAVE: '`',
  KC_COMM: ',',
  KC_COMMA: ',',
  KC_DOT: '.',
  KC_SLSH: '/',
  KC_SLASH: '/',

  // Shifted symbols.
  KC_EXLM: '!',
  KC_AT: '@',
  KC_HASH: '#',
  KC_DLR: '$',
  KC_PERC: '%',
  KC_CIRC: '^',
  KC_AMPR: '&',
  KC_ASTR: '*',
  KC_LPRN: '(',
  KC_RPRN: ')',
  KC_UNDS: '_',
  KC_PLUS: '+',
  KC_LCBR: '{',
  KC_RCBR: '}',
  KC_PIPE: '|',
  KC_COLN: ':',
  KC_DQUO: '"',
  KC_TILD: '~',
  KC_LT: '<',
  KC_GT: '>',
  KC_QUES: '?',

  // Navigation.
  KC_LEFT: 'Left',
  KC_RIGHT: 'Right',
  KC_UP: 'Up',
  KC_DOWN: 'Down',
  KC_HOME: 'Home',
  KC_END: 'End',
  KC_PGUP: 'PageUp',
  KC_PAGE_UP: 'PageUp',
  KC_PGDN: 'PageDown',
  KC_PAGE_DOWN: 'PageDown',

  // System keys.
  KC_PSCR: 'PrintScreen',
  KC_PRINT_SCREEN: 'PrintScreen',
  KC_SCRL: 'ScrollLock',
  KC_SLCK: 'ScrollLock',
  KC_PAUS: 'Pause',
  KC_PAUSE: 'Pause',
  KC_APP: 'Menu',
  KC_APPLICATION: 'Menu',
  KC_NUM: 'NumLock',
  KC_NUM_LOCK: 'NumLock',

  // Numpad.
  KC_KP_0: 'Num 0',
  KC_KP_1: 'Num 1',
  KC_KP_2: 'Num 2',
  KC_KP_3: 'Num 3',
  KC_KP_4: 'Num 4',
  KC_KP_5: 'Num 5',
  KC_KP_6: 'Num 6',
  KC_KP_7: 'Num 7',
  KC_KP_8: 'Num 8',
  KC_KP_9: 'Num 9',
  KC_KP_DOT: 'Num .',
  KC_KP_PLUS: 'Num +',
  KC_KP_MINUS: 'Num -',
  KC_KP_ASTERISK: 'Num *',
  KC_KP_SLASH: 'Num /',
  KC_KP_ENTER: 'Num Enter',
  KC_KP_EQUAL: 'Num =',

  // Media and audio.
  KC_MPLY: 'Play/Pause',
  KC_MEDIA_PLAY_PAUSE: 'Play/Pause',
  KC_MNXT: 'Next track',
  KC_MEDIA_NEXT_TRACK: 'Next track',
  KC_MPRV: 'Prev track',
  KC_MEDIA_PREV_TRACK: 'Prev track',
  KC_MSTP: 'Stop media',
  KC_MEDIA_STOP: 'Stop media',
  KC_VOLU: 'Vol up',
  KC_AUDIO_VOL_UP: 'Vol up',
  KC_VOLD: 'Vol down',
  KC_AUDIO_VOL_DOWN: 'Vol down',
  KC_MUTE: 'Mute',
  KC_AUDIO_MUTE: 'Mute',
  KC_BRIU: 'Bright up',
  KC_BRIGHTNESS_UP: 'Bright up',
  KC_BRID: 'Bright down',
  KC_BRIGHTNESS_DOWN: 'Bright down',

  // Mouse keys.
  KC_MS_U: 'Mouse up',
  KC_MS_UP: 'Mouse up',
  KC_MS_D: 'Mouse down',
  KC_MS_DOWN: 'Mouse down',
  KC_MS_L: 'Mouse left',
  KC_MS_LEFT: 'Mouse left',
  KC_MS_R: 'Mouse right',
  KC_MS_RIGHT: 'Mouse right',
  KC_BTN1: 'Mouse 1',
  KC_MS_BTN1: 'Mouse 1',
  KC_BTN2: 'Mouse 2',
  KC_MS_BTN2: 'Mouse 2',
  KC_BTN3: 'Mouse 3',
  KC_MS_BTN3: 'Mouse 3',
  KC_WH_U: 'Wheel up',
  KC_MS_WH_UP: 'Wheel up',
  KC_WH_D: 'Wheel down',
  KC_MS_WH_DOWN: 'Wheel down',
  KC_WH_L: 'Wheel left',
  KC_WH_R: 'Wheel right',

  // Firmware and lighting keycodes, including the Oryx specific ones.
  QK_BOOT: 'Bootloader',
  RESET: 'Bootloader',
  EE_CLR: 'Clear EEPROM',
  DB_TOGG: 'Debug toggle',
  RGB_TOG: 'RGB on/off',
  RGB_MOD: 'RGB next mode',
  RGB_RMOD: 'RGB prev mode',
  RGB_HUI: 'RGB hue up',
  RGB_HUD: 'RGB hue down',
  RGB_SAI: 'RGB sat up',
  RGB_SAD: 'RGB sat down',
  RGB_VAI: 'RGB bright up',
  RGB_VAD: 'RGB bright down',
  RGB_SPI: 'RGB speed up',
  RGB_SPD: 'RGB speed down',
  RGB_SLD: 'RGB solid',
  TOGGLE_LAYER_COLOR: 'Toggle layer color',
  LED_LEVEL: 'LED level',
  WEBUSB_PAIR: 'Oryx pairing',
  AU_TOG: 'Audio toggle',
  MU_TOG: 'Music toggle',
  CK_TOGG: 'Clicky toggle',
  DYN_REC_START1: 'Record macro 1',
  DYN_REC_START2: 'Record macro 2',
  DYN_REC_STOP: 'Stop recording',
  DYN_MACRO_PLAY1: 'Play macro 1',
  DYN_MACRO_PLAY2: 'Play macro 2',
};

/** Modifier constants used inside MT(), OSM() and friends. */
export const MOD_NAMES: Readonly<Record<string, string>> = {
  MOD_LSFT: 'Shift',
  MOD_RSFT: 'RShift',
  MOD_LCTL: 'Ctrl',
  MOD_RCTL: 'RCtrl',
  MOD_LALT: 'Alt',
  MOD_RALT: 'RAlt',
  MOD_LGUI: 'Gui',
  MOD_RGUI: 'RGui',
  MOD_HYPR: 'Hyper',
  MOD_MEH: 'Meh',
};

/** Wrappers that hold a modifier while sending a keycode, e.g. LSFT(KC_A). */
export const MOD_WRAPPERS: Readonly<Record<string, string>> = {
  LSFT: 'Shift',
  RSFT: 'RShift',
  LCTL: 'Ctrl',
  RCTL: 'RCtrl',
  LALT: 'Alt',
  RALT: 'RAlt',
  LGUI: 'Gui',
  RGUI: 'RGui',
  S: 'Shift',
  C: 'Ctrl',
  A: 'Alt',
  G: 'Gui',
  HYPR: 'Hyper',
  MEH: 'Meh',
  LSA: 'Shift+Alt',
  LCA: 'Ctrl+Alt',
  SGUI: 'Shift+Gui',
  LCAG: 'Ctrl+Alt+Gui',
};

/** Mod tap shorthands: hold for the modifier, tap for the keycode. */
export const MOD_TAP_ALIASES: Readonly<Record<string, string>> = {
  LSFT_T: 'Shift',
  SFT_T: 'Shift',
  RSFT_T: 'RShift',
  LCTL_T: 'Ctrl',
  CTL_T: 'Ctrl',
  RCTL_T: 'RCtrl',
  LALT_T: 'Alt',
  ALT_T: 'Alt',
  RALT_T: 'RAlt',
  LGUI_T: 'Gui',
  GUI_T: 'Gui',
  RGUI_T: 'RGui',
  ALL_T: 'Hyper',
  MEH_T: 'Meh',
};
