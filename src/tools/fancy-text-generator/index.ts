import { ToolError, type ToolLogic } from "../types";

export interface FancyTextOpts {
  zalgoIntensity: number;
  [key: string]: unknown;
}

export type FancyTextResult = Record<string, string>;

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";

/**
 * Builds a character map for one of the Mathematical Alphanumeric Symbols
 * sub-blocks (U+1D400 range): sequential offsets from `upperStart`/`lowerStart`
 * for A-Z/a-z, sequential digits from `digitStart` (or no digit mapping at
 * all when null, since several sub-blocks have no dedicated digit glyphs).
 * `gaps` overrides specific letters that Unicode left unassigned in the math
 * block in favor of a pre-existing legacy symbol (e.g. math italic small h
 * does not exist; U+210E PLANCK CONSTANT stands in for it).
 */
function mathMap(
  upperStart: number,
  lowerStart: number,
  digitStart: number | null,
  gaps: Record<string, number> = {},
): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < 26; i++) {
    const u = UPPER[i]!;
    const l = LOWER[i]!;
    map.set(u, String.fromCodePoint(gaps[u] ?? upperStart + i));
    map.set(l, String.fromCodePoint(gaps[l] ?? lowerStart + i));
  }
  if (digitStart !== null) {
    for (let i = 0; i < 10; i++) {
      const d = DIGITS[i]!;
      map.set(d, String.fromCodePoint(digitStart + i));
    }
  }
  return map;
}

const SCRIPT_GAPS = {
  B: 0x212c,
  E: 0x2130,
  F: 0x2131,
  H: 0x210b,
  I: 0x2110,
  L: 0x2112,
  M: 0x2133,
  R: 0x211b,
  e: 0x212f,
  g: 0x210a,
  o: 0x2134,
};

const FRAKTUR_GAPS = { C: 0x212d, H: 0x210c, I: 0x2111, R: 0x211c, Z: 0x2128 };

const DOUBLE_STRUCK_GAPS = {
  C: 0x2102,
  H: 0x210d,
  N: 0x2115,
  P: 0x2119,
  Q: 0x211a,
  R: 0x211d,
  Z: 0x2124,
};

const BOLD = mathMap(0x1d400, 0x1d41a, 0x1d7ce);
const ITALIC = mathMap(0x1d434, 0x1d44e, null, { h: 0x210e });
const BOLD_ITALIC = mathMap(0x1d468, 0x1d482, null);
const SCRIPT = mathMap(0x1d49c, 0x1d4b6, null, SCRIPT_GAPS);
const FRAKTUR = mathMap(0x1d504, 0x1d51e, null, FRAKTUR_GAPS);
const DOUBLE_STRUCK = mathMap(0x1d538, 0x1d552, 0x1d7d8, DOUBLE_STRUCK_GAPS);
const MONOSPACE = mathMap(0x1d670, 0x1d68a, 0x1d7f6);
const SANS = mathMap(0x1d5a0, 0x1d5ba, 0x1d7e2);
const SANS_BOLD = mathMap(0x1d5d4, 0x1d5ee, 0x1d7ec);
const SANS_ITALIC = mathMap(0x1d608, 0x1d622, null);
const SANS_BOLD_ITALIC = mathMap(0x1d63c, 0x1d656, null);

const CIRCLED = mathMap(0x24b6, 0x24d0, null);
CIRCLED.set("0", String.fromCodePoint(0x24ea));
for (let i = 1; i <= 9; i++) CIRCLED.set(String(i), String.fromCodePoint(0x2460 + (i - 1)));

const SQUARED = new Map<string, string>();
for (let i = 0; i < 26; i++) {
  const glyph = String.fromCodePoint(0x1f130 + i);
  SQUARED.set(UPPER[i]!, glyph);
  SQUARED.set(LOWER[i]!, glyph);
}

const FULLWIDTH = mathMap(0xff21, 0xff41, 0xff10);
FULLWIDTH.set(" ", "　");

const BUBBLE = new Map<string, string>();
for (let i = 0; i < 26; i++) {
  const glyph = String.fromCodePoint(0x1f150 + i);
  BUBBLE.set(UPPER[i]!, glyph);
  BUBBLE.set(LOWER[i]!, glyph);
}
BUBBLE.set("0", String.fromCodePoint(0x24ff));
for (let i = 1; i <= 9; i++) BUBBLE.set(String(i), String.fromCodePoint(0x2776 + (i - 1)));

const SMALL_CAPS_GLYPH: Record<string, number> = {
  a: 0x1d00,
  b: 0x0299,
  c: 0x1d04,
  d: 0x1d05,
  e: 0x1d07,
  f: 0xa730,
  g: 0x0262,
  h: 0x029c,
  i: 0x026a,
  j: 0x1d0a,
  k: 0x1d0b,
  l: 0x029f,
  m: 0x1d0d,
  n: 0x0274,
  o: 0x1d0f,
  p: 0x1d18,
  q: 0xa7af,
  r: 0x0280,
  s: 0xa731,
  t: 0x1d1b,
  u: 0x1d1c,
  v: 0x1d20,
  w: 0x1d21,
  x: 0x0078,
  y: 0x028f,
  z: 0x1d22,
};
const SMALL_CAPS = new Map<string, string>();
for (const l of LOWER) {
  const glyph = String.fromCodePoint(SMALL_CAPS_GLYPH[l]!);
  SMALL_CAPS.set(l, glyph);
  SMALL_CAPS.set(l.toUpperCase(), glyph);
}

const UPSIDE_DOWN_LOWER: Record<string, number> = {
  a: 0x0250,
  b: 0x0071,
  c: 0x0254,
  d: 0x0070,
  e: 0x01dd,
  f: 0x025f,
  g: 0x0183,
  h: 0x0265,
  i: 0x1d09,
  j: 0x027e,
  k: 0x029e,
  l: 0x006c,
  m: 0x026f,
  n: 0x0075,
  o: 0x006f,
  p: 0x0064,
  q: 0x0062,
  r: 0x0279,
  s: 0x0073,
  t: 0x0287,
  u: 0x006e,
  v: 0x028c,
  w: 0x006d,
  x: 0x0078,
  y: 0x028e,
  z: 0x007a,
};
const UPSIDE_DOWN_UPPER: Record<string, number> = {
  A: 0x2200,
  B: 0x0042,
  C: 0x0186,
  D: 0x0044,
  E: 0x018e,
  F: 0x2132,
  G: 0x2141,
  H: 0x0048,
  I: 0x0049,
  J: 0x017f,
  K: 0x004b,
  L: 0xa780,
  M: 0x0057,
  N: 0x004e,
  O: 0x004f,
  P: 0x0500,
  Q: 0x0051,
  R: 0x1d1a,
  S: 0x0053,
  T: 0x22a5,
  U: 0x2229,
  V: 0x039b,
  W: 0x004d,
  X: 0x0058,
  Y: 0x2144,
  Z: 0x005a,
};
const UPSIDE_DOWN_OTHER: Record<string, string> = {
  "6": "9",
  "9": "6",
  ".": "˙",
  ",": "'",
  "'": ",",
  '"': ",,",
  "?": "¿",
  "!": "¡",
  "(": ")",
  ")": "(",
  "[": "]",
  "]": "[",
  "{": "}",
  "}": "{",
  "<": ">",
  ">": "<",
  "&": "⅋",
  _: "‾",
};
const UPSIDE_DOWN = new Map<string, string>();
for (const [k, v] of Object.entries(UPSIDE_DOWN_LOWER)) UPSIDE_DOWN.set(k, String.fromCodePoint(v));
for (const [k, v] of Object.entries(UPSIDE_DOWN_UPPER)) UPSIDE_DOWN.set(k, String.fromCodePoint(v));
for (const [k, v] of Object.entries(UPSIDE_DOWN_OTHER)) UPSIDE_DOWN.set(k, v);

const STRIKE_MARK = "̶";
const UNDERLINE_MARK = "̲";

const ZALGO_UP = [
  0x030d, 0x030e, 0x0304, 0x0305, 0x033f, 0x0311, 0x0306, 0x0310, 0x0352, 0x0357, 0x0351, 0x0307,
  0x0308, 0x030a, 0x0342, 0x0343, 0x0344, 0x034a, 0x034b, 0x034c, 0x0303, 0x0302, 0x030c, 0x0350,
  0x0300, 0x0301, 0x030b, 0x030f, 0x0312, 0x0313, 0x0314, 0x033d, 0x0309,
];
const ZALGO_DOWN = [
  0x0316, 0x0317, 0x0318, 0x0319, 0x031c, 0x031d, 0x031e, 0x031f, 0x0320, 0x0324, 0x0325, 0x0326,
  0x0329, 0x032a, 0x032b, 0x032c, 0x032d, 0x032e, 0x032f, 0x0330, 0x0331, 0x0339, 0x033a, 0x033b,
  0x033c, 0x0345, 0x0347, 0x0348, 0x0349, 0x034d, 0x034e, 0x0323,
];
const ZALGO_MID = [
  0x0315, 0x031b, 0x0340, 0x0341, 0x0358, 0x0321, 0x0322, 0x0327, 0x0328, 0x0334, 0x0335, 0x0336,
  0x035c, 0x035d, 0x035e, 0x035f, 0x0360, 0x0362, 0x0337, 0x0489,
];

/** Deterministic pseudo-random float in [0, 1) from an integer seed. No crypto: zalgo needs a stable, shareable-link-safe pattern, not true randomness. */
function seededFloat(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function zalgify(text: string, intensity: number): string {
  const level = Math.max(0, Math.min(100, Math.round(intensity)));
  if (level === 0) return text;
  const marksPerChar = 1 + Math.floor((level / 100) * 7);
  let out = "";
  let i = 0;
  for (const ch of text) {
    out += ch;
    if (!/\s/.test(ch)) {
      for (let m = 0; m < marksPerChar; m++) {
        const r = seededFloat(i * 97 + m * 13 + 1);
        const pool = r < 0.4 ? ZALGO_UP : r < 0.75 ? ZALGO_DOWN : ZALGO_MID;
        const idx = Math.floor(seededFloat(i * 53 + m * 29 + 7) * pool.length);
        out += String.fromCodePoint(pool[idx]!);
      }
    }
    i++;
  }
  return out;
}

function applyMap(input: string, map: Map<string, string>): string {
  return [...input].map((ch) => map.get(ch) ?? ch).join("");
}

function applyCombining(input: string, mark: string): string {
  return [...input].map((ch) => ch + mark).join("");
}

function upsideDown(input: string): string {
  const mapped = [...input].map((ch) => UPSIDE_DOWN.get(ch) ?? ch);
  return mapped.reverse().join("");
}

export function run(input: string, opts: FancyTextOpts): FancyTextResult {
  const raw = input ?? "";
  if (!raw.trim())
    throw new ToolError(
      "empty-input",
      "Enter some text to convert.",
      'Type or paste text like "Hello World".',
    );

  const intensity = Number.isFinite(opts.zalgoIntensity) ? opts.zalgoIntensity : 40;

  return {
    Bold: applyMap(raw, BOLD),
    Italic: applyMap(raw, ITALIC),
    "Bold Italic": applyMap(raw, BOLD_ITALIC),
    Script: applyMap(raw, SCRIPT),
    Fraktur: applyMap(raw, FRAKTUR),
    "Double-struck": applyMap(raw, DOUBLE_STRUCK),
    Monospace: applyMap(raw, MONOSPACE),
    "Sans-serif": applyMap(raw, SANS),
    "Sans-serif Bold": applyMap(raw, SANS_BOLD),
    "Sans-serif Italic": applyMap(raw, SANS_ITALIC),
    "Sans-serif Bold Italic": applyMap(raw, SANS_BOLD_ITALIC),
    Circled: applyMap(raw, CIRCLED),
    Squared: applyMap(raw, SQUARED),
    Fullwidth: applyMap(raw, FULLWIDTH),
    "Small Caps": applyMap(raw, SMALL_CAPS),
    "Upside Down": upsideDown(raw),
    Strikethrough: applyCombining(raw, STRIKE_MARK),
    Underline: applyCombining(raw, UNDERLINE_MARK),
    Bubble: applyMap(raw, BUBBLE),
    Zalgo: zalgify(raw, intensity),
  };
}

export default { run } satisfies ToolLogic<string, FancyTextResult, FancyTextOpts>;
