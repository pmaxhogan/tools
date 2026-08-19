/**
 * Keyboard layout data for the heatmap.
 *
 * The physical board is defined once: a standard ANSI 104 key alpha block with
 * the number row, four rows of 13, 12, 11 and 10 keys. Every layout then only
 * supplies the characters that sit on those positions, so finger assignment,
 * row stagger and home row flags can never drift between layouts.
 *
 * Row stagger uses the real ANSI key unit offsets measured from the left edge
 * of the board: the number row starts at 0, the top row at 1.5, the home row
 * at 1.75 and the bottom row at 2.25. Relative to the digit columns that is a
 * stagger of 0.5, 0.75 and 1.25 key units, which is what a standard row
 * staggered keyboard actually has.
 *
 * Sources for the less common layouts:
 * Halmak from the upstream XKB symbols file (kaievns/halmak, linux/symbols).
 * Graphite from the ASCII grid in rdavison/graphite-layout README.
 * ANSI has no key for the extra ISO position, so the AZERTY and QWERTZ rows
 * that would use it (the French bottom row "<" and the German "#") are left
 * out rather than squeezed in somewhere they do not belong.
 */

export type Hand = "left" | "right";

/**
 * Finger indices. Thumbs are deliberately absent: the space bar is treated as
 * a separator between keystrokes, never as load on one of these eight fingers.
 *
 * 0 LP, 1 LR, 2 LM, 3 LI, 4 RI, 5 RM, 6 RR, 7 RP
 */
export const FINGER_CODES = ["LP", "LR", "LM", "LI", "RI", "RM", "RR", "RP"] as const;

/** Spelled out finger names, same order as FINGER_CODES. */
export const FINGER_LABELS = [
  "left pinky",
  "left ring",
  "left middle",
  "left index",
  "right index",
  "right middle",
  "right ring",
  "right pinky",
] as const;

/** Row names, indexed by the row number stored on every key. */
export const ROW_LABELS = ["number row", "top row", "home row", "bottom row"] as const;

/** Left index is finger 3, right index is finger 4. */
export const LEFT_INDEX = 3;
export const RIGHT_INDEX = 4;

export interface LayoutKey {
  /** The character this key produces with no modifier, always lower case. */
  char: string;
  /** The character this key produces with Shift, or "" when it has none. */
  shifted: string;
  /** 0 number row, 1 top row, 2 home row, 3 bottom row. */
  row: number;
  /** Position within the row, counted from the left, starting at 0. */
  col: number;
  /** 0..7, see FINGER_CODES. Thumbs are excluded. */
  finger: number;
  hand: Hand;
  /** Distance of the key's left edge from the left edge of the board, in key units. */
  x: number;
  /** True for every key on the home row, the G and H stretch columns included. */
  home: boolean;
  /** True only for the eight keys a finger actually rests on: a s d f j k l ; positions. */
  resting: boolean;
  /**
   * True when the key sits in an inner index column, the column an index
   * finger has to leave its own column to reach. On QWERTY those are the
   * t/g/b and y/h/n columns plus the 5 and 6 keys.
   */
  innerIndex: boolean;
}

export interface Layout {
  id: string;
  name: string;
  keys: LayoutKey[];
}

/* ------------------------------------------------------------------ *
 * The physical ANSI grid
 * ------------------------------------------------------------------ */

/** Left edge of the first key in each row, in key units. */
const ROW_START_X = [0, 1.5, 1.75, 2.25];

/** Finger for every column of every row, using the standard touch typing map. */
const ROW_FINGERS: number[][] = [
  // ` 1 2 3 4 5 6 7 8 9 0 - =
  [0, 0, 1, 2, 3, 3, 4, 4, 5, 6, 7, 7, 7],
  // q w e r t y u i o p [ ]
  [0, 1, 2, 3, 3, 4, 4, 5, 6, 7, 7, 7],
  // a s d f g h j k l ; '
  [0, 1, 2, 3, 3, 4, 4, 5, 6, 7, 7],
  // z x c v b n m , . /
  [0, 1, 2, 3, 3, 4, 4, 5, 6, 7],
];

/** Columns of the home row the eight fingers rest on. */
const HOME_ROW = 2;
const HOME_COLS = new Set([0, 1, 2, 3, 6, 7, 8, 9]);

/**
 * The inner index column of each row, derived rather than hand listed: the
 * left index owns two columns and stretches to the higher one, the right index
 * owns two and stretches to the lower one.
 */
const INNER_INDEX_COLS: { left: number; right: number }[] = ROW_FINGERS.map((fingers) => {
  const leftCols: number[] = [];
  const rightCols: number[] = [];
  fingers.forEach((finger, col) => {
    if (finger === LEFT_INDEX) leftCols.push(col);
    if (finger === RIGHT_INDEX) rightCols.push(col);
  });
  return { left: Math.max(...leftCols), right: Math.min(...rightCols) };
});

/** Resting x position of every finger, taken from its home row key. */
export const FINGER_HOME_X: number[] = (() => {
  const homes: number[] = new Array(8).fill(0);
  ROW_FINGERS[HOME_ROW].forEach((finger, col) => {
    if (HOME_COLS.has(col)) homes[finger] = ROW_START_X[HOME_ROW] + col;
  });
  return homes;
})();

/** Stable identifier for a key position, shared by the analyzer and the SVG. */
export function keyId(key: { row: number; col: number }): string {
  return `${key.row}-${key.col}`;
}

/* ------------------------------------------------------------------ *
 * Layout character maps
 * ------------------------------------------------------------------ */

interface LayoutSpec {
  id: string;
  name: string;
  /** Four rows of 13, 12, 11 and 10 characters, unshifted. */
  rows: [string, string, string, string];
  /** The same four rows with Shift held. */
  shifted: [string, string, string, string];
}

const SPECS: LayoutSpec[] = [
  {
    id: "qwerty",
    name: "QWERTY",
    rows: ["`1234567890-=", "qwertyuiop[]", "asdfghjkl;'", "zxcvbnm,./"],
    shifted: ["~!@#$%^&*()_+", "QWERTYUIOP{}", 'ASDFGHJKL:"', "ZXCVBNM<>?"],
  },
  {
    id: "dvorak",
    name: "Dvorak",
    rows: ["`1234567890[]", "',.pyfgcrl/=", "aoeuidhtns-", ";qjkxbmwvz"],
    shifted: ["~!@#$%^&*(){}", '"<>PYFGCRL?+', "AOEUIDHTNS_", ":QJKXBMWVZ"],
  },
  {
    id: "colemak",
    name: "Colemak",
    rows: ["`1234567890-=", "qwfpgjluy;[]", "arstdhneio'", "zxcvbkm,./"],
    shifted: ["~!@#$%^&*()_+", "QWFPGJLUY:{}", 'ARSTDHNEIO"', "ZXCVBKM<>?"],
  },
  {
    id: "colemak-dh",
    name: "Colemak-DH",
    rows: ["`1234567890-=", "qwfpbjluy;[]", "arstgmneio'", "zxcdvkh,./"],
    shifted: ["~!@#$%^&*()_+", "QWFPBJLUY:{}", 'ARSTGMNEIO"', "ZXCDVKH<>?"],
  },
  {
    id: "workman",
    name: "Workman",
    rows: ["`1234567890-=", "qdrwbjfup;[]", "ashtgyneoi'", "zxmcvkl,./"],
    shifted: ["~!@#$%^&*()_+", "QDRWBJFUP:{}", 'ASHTGYNEOI"', "ZXMCVKL<>?"],
  },
  {
    id: "norman",
    name: "Norman",
    rows: ["`1234567890-=", "qwdfkjurl;[]", "asetgynioh'", "zxcvbpm,./"],
    shifted: ["~!@#$%^&*()_+", "QWDFKJURL:{}", 'ASETGYNIOH"', "ZXCVBPM<>?"],
  },
  {
    id: "halmak",
    name: "Halmak",
    rows: ["`1234567890-=", "wlrbz;qudj[]", "shnt,.aeoi'", "fmvc/gpxky"],
    shifted: ["~!@#$%^&*<>_+", "WLRBZ:QUDJ{}", 'SHNT()AEOI"', "FMVC?GPXKY"],
  },
  {
    id: "graphite",
    name: "Graphite",
    rows: ["`1234567890[]", "bldwz'fouj;=", "nrtsgyhaei,", "qxmcvkp.-/"],
    shifted: ["~!@#$%^&*(){}", "BLDWZ_FOUJ:+", "NRTSGYHAEI?", 'QXMCVKP>"<'],
  },
  {
    id: "azerty",
    name: "AZERTY (French)",
    rows: ["²&é\"'(-è_çà)=", "azertyuiop^$", "qsdfghjklmù", "wxcvbn,;:!"],
    shifted: ["³1234567890°+", "AZERTYUIOP¨£", "QSDFGHJKLM%", "WXCVBN?./§"],
  },
  {
    id: "qwertz",
    name: "QWERTZ (German)",
    rows: ["^1234567890ß´", "qwertzuiopü+", "asdfghjklöä", "yxcvbnm,.-"],
    shifted: ['°!"§$%&/()=?`', "QWERTZUIOPÜ*", "ASDFGHJKLÖÄ", "YXCVBNM;:_"],
  },
];

function buildLayout(spec: LayoutSpec): Layout {
  const keys: LayoutKey[] = [];
  for (let row = 0; row < 4; row++) {
    const chars = [...spec.rows[row]];
    const shifted = [...spec.shifted[row]];
    const fingers = ROW_FINGERS[row];
    for (let col = 0; col < fingers.length; col++) {
      const char = chars[col] ?? "";
      if (char === "") continue;
      const finger = fingers[col];
      keys.push({
        char,
        shifted: shifted[col] ?? "",
        row,
        col,
        finger,
        hand: finger <= LEFT_INDEX ? "left" : "right",
        x: ROW_START_X[row] + col,
        home: row === HOME_ROW,
        resting: row === HOME_ROW && HOME_COLS.has(col),
        innerIndex:
          (finger === LEFT_INDEX && col === INNER_INDEX_COLS[row].left) ||
          (finger === RIGHT_INDEX && col === INNER_INDEX_COLS[row].right),
      });
    }
  }
  return { id: spec.id, name: spec.name, keys };
}

/** Every supported layout, keyed by its id. */
export const LAYOUTS: Record<string, Layout> = Object.fromEntries(
  SPECS.map((spec) => [spec.id, buildLayout(spec)]),
);

/** Layout ids in the order the tool presents them. */
export const LAYOUT_IDS: string[] = SPECS.map((spec) => spec.id);

/* ------------------------------------------------------------------ *
 * Lookups
 * ------------------------------------------------------------------ */

const INDEX_CACHE = new Map<string, Map<string, LayoutKey>>();

/**
 * Character to key map for a layout. Unshifted characters win over shifted
 * ones, so a layout that puts the same symbol on two keys resolves to the
 * easier of the two. Built once per layout and cached.
 */
export function characterIndex(layout: Layout): Map<string, LayoutKey> {
  const cached = INDEX_CACHE.get(layout.id);
  if (cached) return cached;

  const index = new Map<string, LayoutKey>();
  for (const key of layout.keys) {
    if (key.char !== "" && !index.has(key.char)) index.set(key.char, key);
  }
  for (const key of layout.keys) {
    if (key.shifted !== "" && !index.has(key.shifted)) index.set(key.shifted, key);
  }
  INDEX_CACHE.set(layout.id, index);
  return index;
}

/** The key a character is typed on, or undefined when the layout has none. */
export function keyForChar(layout: Layout, char: string): LayoutKey | undefined {
  const index = characterIndex(layout);
  const direct = index.get(char);
  if (direct) return direct;
  const lower = char.toLowerCase();
  if (lower !== char) return index.get(lower);
  const upper = char.toUpperCase();
  if (upper !== char) return index.get(upper);
  return undefined;
}

/** Spellings people type that should resolve to a layout id. */
const LAYOUT_SYNONYMS: Record<string, string> = {
  qwerty: "qwerty",
  standard: "qwerty",
  default: "qwerty",
  us: "qwerty",
  dvorak: "dvorak",
  colemak: "colemak",
  cmk: "colemak",
  colemakdh: "colemak-dh",
  colemakmoddh: "colemak-dh",
  moddh: "colemak-dh",
  dh: "colemak-dh",
  cmkdh: "colemak-dh",
  curl: "colemak-dh",
  workman: "workman",
  norman: "norman",
  halmak: "halmak",
  graphite: "graphite",
  azerty: "azerty",
  french: "azerty",
  qwertz: "qwertz",
  german: "qwertz",
};

/**
 * Turn whatever the caller typed into a layout id. Case, spaces, hyphens and
 * underscores are all ignored, so "Colemak DH", "colemak_dh" and "mod-dh" all
 * land on colemak-dh. Returns undefined when nothing matches.
 */
export function resolveLayoutId(raw: string): string | undefined {
  const normalized = String(raw ?? "")
    .toLowerCase()
    .replace(/[\s\-_]+/g, "");
  if (normalized === "") return undefined;
  return LAYOUT_SYNONYMS[normalized];
}
