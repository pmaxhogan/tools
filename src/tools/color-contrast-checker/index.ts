/**
 * Color Contrast Checker logic.
 *
 * Takes a foreground and a background written in any CSS color syntax and
 * answers three questions about the pair: the WCAG 2.x contrast ratio with a
 * pass or fail against every threshold, the APCA Lc value with the readability
 * guidance that goes with it, and, when the pair fails, the nearest foreground
 * that passes.
 *
 * The color parsing, conversion and gamut mapping below are a deliberate copy
 * of the same code in src/tools/color-picker/index.ts. PROJECT.md rule 13
 * says every tool stays independently deletable, and the two tools are wired
 * into the registry separately, so they carry their own copy rather than
 * importing across tool directories. The copied part ends at the formatting
 * section; everything below it is specific to contrast.
 */

import { ToolError, type ToolLogic } from "../types";

/* -------------------------------------------------------------------- types */

/** The color syntax a value was written in. */
export type ColorFormat =
  "hex" | "rgb" | "hsl" | "hwb" | "oklch" | "oklab" | "lab" | "lch" | "named";

/** Gamma encoded sRGB plus alpha, every channel a 0..1 float. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A parsed color: normalized sRGB, the syntax it came from, gamut notes. */
export interface ParsedColor extends Rgba {
  format: ColorFormat;
  /** True when the written color sat outside sRGB and had to be mapped in. */
  clipped: boolean;
  /** OKLCH chroma the input asked for. Present only when `clipped`. */
  requestedChroma?: number;
  /** OKLCH chroma actually used after reduction. Present only when `clipped`. */
  mappedChroma?: number;
}

/** A three component color vector. Its meaning depends on the space. */
export type Vec3 = [number, number, number];

/* ------------------------------------------------------------ named colors */

/**
 * The 148 CSS Color 4 named colors: the 147 CSS 2.1 and SVG keywords plus
 * rebeccapurple. `transparent` and `currentColor` are separate keywords and
 * are deliberately not in this table.
 */
export const NAMED_COLORS: Readonly<Record<string, string>> = {
  aliceblue: "#f0f8ff",
  antiquewhite: "#faebd7",
  aqua: "#00ffff",
  aquamarine: "#7fffd4",
  azure: "#f0ffff",
  beige: "#f5f5dc",
  bisque: "#ffe4c4",
  black: "#000000",
  blanchedalmond: "#ffebcd",
  blue: "#0000ff",
  blueviolet: "#8a2be2",
  brown: "#a52a2a",
  burlywood: "#deb887",
  cadetblue: "#5f9ea0",
  chartreuse: "#7fff00",
  chocolate: "#d2691e",
  coral: "#ff7f50",
  cornflowerblue: "#6495ed",
  cornsilk: "#fff8dc",
  crimson: "#dc143c",
  cyan: "#00ffff",
  darkblue: "#00008b",
  darkcyan: "#008b8b",
  darkgoldenrod: "#b8860b",
  darkgray: "#a9a9a9",
  darkgreen: "#006400",
  darkgrey: "#a9a9a9", // spelling: allow (a CSS Color 4 keyword)
  darkkhaki: "#bdb76b",
  darkmagenta: "#8b008b",
  darkolivegreen: "#556b2f",
  darkorange: "#ff8c00",
  darkorchid: "#9932cc",
  darkred: "#8b0000",
  darksalmon: "#e9967a",
  darkseagreen: "#8fbc8f",
  darkslateblue: "#483d8b",
  darkslategray: "#2f4f4f",
  darkslategrey: "#2f4f4f", // spelling: allow (a CSS Color 4 keyword)
  darkturquoise: "#00ced1",
  darkviolet: "#9400d3",
  deeppink: "#ff1493",
  deepskyblue: "#00bfff",
  dimgray: "#696969",
  dimgrey: "#696969", // spelling: allow (a CSS Color 4 keyword)
  dodgerblue: "#1e90ff",
  firebrick: "#b22222",
  floralwhite: "#fffaf0",
  forestgreen: "#228b22",
  fuchsia: "#ff00ff",
  gainsboro: "#dcdcdc",
  ghostwhite: "#f8f8ff",
  gold: "#ffd700",
  goldenrod: "#daa520",
  gray: "#808080",
  green: "#008000",
  greenyellow: "#adff2f",
  grey: "#808080", // spelling: allow (a CSS Color 4 keyword)
  honeydew: "#f0fff0",
  hotpink: "#ff69b4",
  indianred: "#cd5c5c",
  indigo: "#4b0082",
  ivory: "#fffff0",
  khaki: "#f0e68c",
  lavender: "#e6e6fa",
  lavenderblush: "#fff0f5",
  lawngreen: "#7cfc00",
  lemonchiffon: "#fffacd",
  lightblue: "#add8e6",
  lightcoral: "#f08080",
  lightcyan: "#e0ffff",
  lightgoldenrodyellow: "#fafad2",
  lightgray: "#d3d3d3",
  lightgreen: "#90ee90",
  lightgrey: "#d3d3d3", // spelling: allow (a CSS Color 4 keyword)
  lightpink: "#ffb6c1",
  lightsalmon: "#ffa07a",
  lightseagreen: "#20b2aa",
  lightskyblue: "#87cefa",
  lightslategray: "#778899",
  lightslategrey: "#778899", // spelling: allow (a CSS Color 4 keyword)
  lightsteelblue: "#b0c4de",
  lightyellow: "#ffffe0",
  lime: "#00ff00",
  limegreen: "#32cd32",
  linen: "#faf0e6",
  magenta: "#ff00ff",
  maroon: "#800000",
  mediumaquamarine: "#66cdaa",
  mediumblue: "#0000cd",
  mediumorchid: "#ba55d3",
  mediumpurple: "#9370db",
  mediumseagreen: "#3cb371",
  mediumslateblue: "#7b68ee",
  mediumspringgreen: "#00fa9a",
  mediumturquoise: "#48d1cc",
  mediumvioletred: "#c71585",
  midnightblue: "#191970",
  mintcream: "#f5fffa",
  mistyrose: "#ffe4e1",
  moccasin: "#ffe4b5",
  navajowhite: "#ffdead",
  navy: "#000080",
  oldlace: "#fdf5e6",
  olive: "#808000",
  olivedrab: "#6b8e23",
  orange: "#ffa500",
  orangered: "#ff4500",
  orchid: "#da70d6",
  palegoldenrod: "#eee8aa",
  palegreen: "#98fb98",
  paleturquoise: "#afeeee",
  palevioletred: "#db7093",
  papayawhip: "#ffefd5",
  peachpuff: "#ffdab9",
  peru: "#cd853f",
  pink: "#ffc0cb",
  plum: "#dda0dd",
  powderblue: "#b0e0e6",
  purple: "#800080",
  rebeccapurple: "#663399",
  red: "#ff0000",
  rosybrown: "#bc8f8f",
  royalblue: "#4169e1",
  saddlebrown: "#8b4513",
  salmon: "#fa8072",
  sandybrown: "#f4a460",
  seagreen: "#2e8b57",
  seashell: "#fff5ee",
  sienna: "#a0522d",
  silver: "#c0c0c0",
  skyblue: "#87ceeb",
  slateblue: "#6a5acd",
  slategray: "#708090",
  slategrey: "#708090", // spelling: allow (a CSS Color 4 keyword)
  snow: "#fffafa",
  springgreen: "#00ff7f",
  steelblue: "#4682b4",
  tan: "#d2b48c",
  teal: "#008080",
  thistle: "#d8bfd8",
  tomato: "#ff6347",
  turquoise: "#40e0d0",
  violet: "#ee82ee",
  wheat: "#f5deb3",
  white: "#ffffff",
  whitesmoke: "#f5f5f5",
  yellow: "#ffff00",
  yellowgreen: "#9acd32",
};

/* ------------------------------------------------------------------- basics */

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function mul3(m: readonly Vec3[], v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function normalizeHue(h: number): number {
  const x = h % 360;
  return x < 0 ? x + 360 : x;
}

/** sRGB transfer function: one gamma encoded 0..1 channel to linear light. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Inverse sRGB transfer function: linear light back to gamma encoded 0..1. */
export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function decode(rgb: Vec3): Vec3 {
  return [srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2])];
}

function encode(lin: Vec3): Vec3 {
  return [
    linearToSrgb(clamp(lin[0], 0, 1)),
    linearToSrgb(clamp(lin[1], 0, 1)),
    linearToSrgb(clamp(lin[2], 0, 1)),
  ];
}

/* -------------------------------------------------------------------- OKLab */

/**
 * The OKLab matrices published by Bjorn Ottosson, used exactly as given:
 * linear sRGB into the cone response space, then the non linear LMS step.
 */
const LIN_RGB_TO_LMS: readonly Vec3[] = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
];
const LMS_TO_OKLAB: readonly Vec3[] = [
  [0.2104542553, 0.793617785, -0.0040720468],
  [1.9779984951, -2.428592205, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.808675766],
];
const OKLAB_TO_LMS: readonly Vec3[] = [
  [1, 0.3963377774, 0.2158037573],
  [1, -0.1055613458, -0.0638541728],
  [1, -0.0894841775, -1.291485548],
];
const LMS_TO_LIN_RGB: readonly Vec3[] = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.707614701],
];

/** Linear sRGB to OKLab. */
export function linearToOklab(lin: Vec3): Vec3 {
  const lms = mul3(LIN_RGB_TO_LMS, lin);
  return mul3(LMS_TO_OKLAB, [Math.cbrt(lms[0]), Math.cbrt(lms[1]), Math.cbrt(lms[2])]);
}

/** OKLab to linear sRGB. Lands outside 0..1 when the color is out of gamut. */
export function oklabToLinear(lab: Vec3): Vec3 {
  const lms = mul3(OKLAB_TO_LMS, lab);
  return mul3(LMS_TO_LIN_RGB, [lms[0] ** 3, lms[1] ** 3, lms[2] ** 3]);
}

/** Rectangular to polar. Works for both OKLab and CIE Lab. Hue in degrees. */
export function labToLch(lab: Vec3): Vec3 {
  const c = Math.hypot(lab[1], lab[2]);
  const h = c === 0 ? 0 : normalizeHue((Math.atan2(lab[2], lab[1]) * 180) / Math.PI);
  return [lab[0], c, h];
}

/** Polar to rectangular. Works for both OKLCH and CIE LCH. Hue in degrees. */
export function lchToLab(lch: Vec3): Vec3 {
  const h = (lch[2] * Math.PI) / 180;
  return [lch[0], lch[1] * Math.cos(h), lch[1] * Math.sin(h)];
}

/* ------------------------------------------------------------- XYZ and Lab */

/** Linear sRGB to CIE XYZ with a D65 white point (CSS Color 4 matrix). */
const LIN_RGB_TO_XYZ_D65: readonly Vec3[] = [
  [506752 / 1228815, 87881 / 245763, 12673 / 70218],
  [87098 / 409605, 175762 / 245763, 12673 / 175545],
  [7918 / 409605, 87881 / 737289, 1001167 / 1053270],
];
const XYZ_D65_TO_LIN_RGB: readonly Vec3[] = [
  [12831 / 3959, -329 / 214, -1974 / 3959],
  [-851781 / 878810, 1648619 / 878810, 36519 / 878810],
  [705 / 12673, -2585 / 12673, 705 / 667],
];

/** Bradford chromatic adaptation, D65 to D50 and back (CSS Color 4 matrices). */
const BRADFORD_D65_TO_D50: readonly Vec3[] = [
  [1.0479298208405488, 0.022946793341019088, -0.05019222954313557],
  [0.029627815688159344, 0.990434484573249, -0.01707382502938514],
  [-0.009243058152591178, 0.015055144896577895, 0.7518742899580008],
];
const BRADFORD_D50_TO_D65: readonly Vec3[] = [
  [0.9554734527042182, -0.023098536874261423, 0.0632593086610217],
  [-0.028369706963208136, 1.0099954580058226, 0.021041398966943008],
  [0.012314001688319899, -0.020507696433477912, 1.3303659366080753],
];

/** The CIE white points as XYZ, from the CSS Color 4 chromaticities. */
export const WHITE_D50: Vec3 = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];
export const WHITE_D65: Vec3 = [0.3127 / 0.329, 1, (1 - 0.3127 - 0.329) / 0.329];

const LAB_E = 216 / 24389;
const LAB_K = 24389 / 27;

/** CIE XYZ to CIE Lab against the given white point. */
export function xyzToLab(xyz: Vec3, white: Vec3): Vec3 {
  const f = (t: number): number => (t > LAB_E ? Math.cbrt(t) : (LAB_K * t + 16) / 116);
  const fx = f(xyz[0] / white[0]);
  const fy = f(xyz[1] / white[1]);
  const fz = f(xyz[2] / white[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE Lab to CIE XYZ against the given white point. */
export function labToXyz(lab: Vec3, white: Vec3): Vec3 {
  const fy = (lab[0] + 16) / 116;
  const fx = lab[1] / 500 + fy;
  const fz = fy - lab[2] / 200;
  const inv = (t: number): number => (t ** 3 > LAB_E ? t ** 3 : (116 * t - 16) / LAB_K);
  const y = lab[0] > LAB_K * LAB_E ? fy ** 3 : lab[0] / LAB_K;
  return [inv(fx) * white[0], y * white[1], inv(fz) * white[2]];
}

/* ------------------------------------------------- sRGB entry point wrappers */

/** Gamma encoded sRGB (0..1) to OKLab. */
export function srgbToOklab(rgb: Vec3): Vec3 {
  return linearToOklab(decode(rgb));
}

/** Gamma encoded sRGB (0..1) to OKLCH. */
export function srgbToOklch(rgb: Vec3): Vec3 {
  return labToLch(srgbToOklab(rgb));
}

/** Gamma encoded sRGB (0..1) to CIE XYZ, D65. */
export function srgbToXyzD65(rgb: Vec3): Vec3 {
  return mul3(LIN_RGB_TO_XYZ_D65, decode(rgb));
}

/** Gamma encoded sRGB (0..1) to CIE Lab under D65. Not the CSS `lab()` white point. */
export function srgbToLabD65(rgb: Vec3): Vec3 {
  return xyzToLab(srgbToXyzD65(rgb), WHITE_D65);
}

/** Gamma encoded sRGB (0..1) to CIE Lab under D50, the white point CSS `lab()` uses. */
export function srgbToLabD50(rgb: Vec3): Vec3 {
  return xyzToLab(mul3(BRADFORD_D65_TO_D50, srgbToXyzD65(rgb)), WHITE_D50);
}

/** Gamma encoded sRGB (0..1) to CIE LCH under D50, the CSS `lch()` white point. */
export function srgbToLchD50(rgb: Vec3): Vec3 {
  return labToLch(srgbToLabD50(rgb));
}

/** CIE Lab under D50 to unclamped linear sRGB. */
function labD50ToLinear(lab: Vec3): Vec3 {
  return mul3(XYZ_D65_TO_LIN_RGB, mul3(BRADFORD_D50_TO_D65, labToXyz(lab, WHITE_D50)));
}

/* -------------------------------------------------------------- HSL and HWB */

/** Gamma encoded sRGB (0..1) to HSL: [hue 0..360, saturation 0..100, lightness 0..100]. */
export function srgbToHsl(rgb: Vec3): Vec3 {
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l * 100];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [normalizeHue(h * 60), s * 100, l * 100];
}

/** HSL ([hue degrees, saturation 0..100, lightness 0..100]) to gamma encoded sRGB. */
export function hslToSrgb(hsl: Vec3): Vec3 {
  const h = normalizeHue(hsl[0]) / 360;
  const s = clamp(hsl[1], 0, 100) / 100;
  const l = clamp(hsl[2], 0, 100) / 100;
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}

/** Gamma encoded sRGB (0..1) to HWB: [hue 0..360, whiteness 0..100, blackness 0..100]. */
export function srgbToHwb(rgb: Vec3): Vec3 {
  const hue = srgbToHsl(rgb)[0];
  const w = Math.min(rgb[0], rgb[1], rgb[2]);
  const bl = 1 - Math.max(rgb[0], rgb[1], rgb[2]);
  return [hue, w * 100, bl * 100];
}

/**
 * HWB ([hue degrees, whiteness 0..100, blackness 0..100]) to gamma encoded sRGB.
 * When whiteness plus blackness reaches 100 the result is the gray they imply,
 * which is what CSS Color 4 requires.
 */
export function hwbToSrgb(hwb: Vec3): Vec3 {
  const w = clamp(hwb[1], 0, 100) / 100;
  const bl = clamp(hwb[2], 0, 100) / 100;
  if (w + bl >= 1) {
    const gray = w / (w + bl);
    return [gray, gray, gray];
  }
  const base = hslToSrgb([hwb[0], 100, 50]);
  const span = 1 - w - bl;
  return [base[0] * span + w, base[1] * span + w, base[2] * span + w];
}

/* ------------------------------------------------------------ gamut mapping */

/** Slack allowed on a channel before a color counts as outside sRGB. */
export const GAMUT_EPSILON = 1e-5;

/** The outcome of fitting an OKLCH color into sRGB. */
export interface GamutResult {
  /** Gamma encoded sRGB, clamped to 0..1. */
  rgb: Vec3;
  /** The chroma actually used. Equals the requested chroma when nothing moved. */
  chroma: number;
  /** True when the requested color did not fit inside sRGB. */
  clipped: boolean;
}

function inGamut(lin: Vec3): boolean {
  return (
    lin[0] >= -GAMUT_EPSILON &&
    lin[0] <= 1 + GAMUT_EPSILON &&
    lin[1] >= -GAMUT_EPSILON &&
    lin[1] <= 1 + GAMUT_EPSILON &&
    lin[2] >= -GAMUT_EPSILON &&
    lin[2] <= 1 + GAMUT_EPSILON
  );
}

/**
 * Fit an OKLCH color into sRGB by reducing chroma, holding lightness and hue.
 * A binary search finds the largest chroma that still fits, to a tolerance of
 * 1e-6. Lightness outside 0..1 cannot be fixed by chroma alone, so the final
 * channels are always clamped as well and `clipped` reports that the color
 * you asked for was not reachable.
 */
export function gamutMapOklch(l: number, c: number, h: number): GamutResult {
  const wanted = Math.max(c, 0);
  const direct = oklabToLinear(lchToLab([l, wanted, h]));
  if (inGamut(direct)) return { rgb: encode(direct), chroma: wanted, clipped: false };

  let lo = 0;
  let hi = wanted;
  for (let i = 0; i < 48 && hi - lo > 1e-6; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklabToLinear(lchToLab([l, mid, h])))) lo = mid;
    else hi = mid;
  }
  return { rgb: encode(oklabToLinear(lchToLab([l, lo, h]))), chroma: lo, clipped: true };
}

/* ------------------------------------------------------------------ parsing */

function badColor(token: string): ToolError {
  return new ToolError(
    "bad-color",
    `Could not read "${token}" as a color.`,
    "Accepted syntaxes: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(255 0 0 / 50%), rgba(255, 0, 0, 0.5), hsl(270 50% 40%), hwb(270 20% 30%), lab(54 81 70), lch(54 107 41), oklab(0.63 0.22 0.13), oklch(0.63 0.26 29), or a CSS color name such as rebeccapurple.",
  );
}

function emptyInput(): ToolError {
  return new ToolError(
    "empty-input",
    "Enter a color to work with.",
    "Try #663399, rgb(102 51 153), hsl(270 50% 40%), oklch(0.44 0.16 303), or rebeccapurple.",
  );
}

interface Numish {
  value: number;
  percent: boolean;
}

function readNumber(tok: string, token: string): Numish {
  const t = tok.trim().toLowerCase();
  if (t === "none") return { value: 0, percent: false };
  const percent = t.endsWith("%");
  const body = percent ? t.slice(0, -1).trim() : t;
  if (body === "") throw badColor(token);
  const value = Number(body);
  if (!Number.isFinite(value)) throw badColor(token);
  return { value, percent };
}

const ANGLE_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|grad|rad|turn)?$/i;

function readAngle(tok: string, token: string): number {
  const t = tok.trim().toLowerCase();
  if (t === "none") return 0;
  const m = ANGLE_RE.exec(t);
  if (!m) throw badColor(token);
  const v = Number(m[1]);
  const unit = m[2] ?? "deg";
  const deg =
    unit === "rad"
      ? (v * 180) / Math.PI
      : unit === "grad"
        ? v * 0.9
        : unit === "turn"
          ? v * 360
          : v;
  return normalizeHue(deg);
}

function readAlpha(tok: string, token: string): number {
  const n = readNumber(tok, token);
  return clamp(n.percent ? n.value / 100 : n.value, 0, 1);
}

/** A percentage or a bare number on the same 0..100 scale (hsl, hwb, lab lightness). */
function readPercentish(tok: string, token: string): number {
  return readNumber(tok, token).value;
}

/** A signed component where 100% maps to `full` (lab a/b, oklab a/b, chroma). */
function readScaled(tok: string, token: string, full: number): number {
  const n = readNumber(tok, token);
  return n.percent ? (n.value / 100) * full : n.value;
}

interface FuncArgs {
  parts: string[];
  alpha: string | null;
}

/** Split a color function body into components plus an optional alpha. */
function splitFuncArgs(body: string): FuncArgs {
  const slash = body.indexOf("/");
  let head = body;
  let alpha: string | null = null;
  if (slash >= 0) {
    alpha = body.slice(slash + 1).trim();
    head = body.slice(0, slash);
  }
  const hasComma = head.includes(",");
  const parts = head
    .split(hasComma ? "," : /\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (alpha === null && hasComma && parts.length === 4) alpha = parts.pop() ?? null;
  return { parts, alpha };
}

function fromHex(raw: string, token: string): ParsedColor {
  const h = raw.startsWith("#") ? raw.slice(1) : raw;
  if (!/^[0-9a-f]+$/.test(h) || ![3, 4, 6, 8].includes(h.length)) throw badColor(token);
  if (h.length <= 4) {
    const nibble = (s: string): number => parseInt(s + s, 16) / 255;
    return {
      r: nibble(h[0]),
      g: nibble(h[1]),
      b: nibble(h[2]),
      a: h.length === 4 ? nibble(h[3]) : 1,
      format: "hex",
      clipped: false,
    };
  }
  const pair = (i: number): number => parseInt(h.slice(i, i + 2), 16) / 255;
  return {
    r: pair(0),
    g: pair(2),
    b: pair(4),
    a: h.length === 8 ? pair(6) : 1,
    format: "hex",
    clipped: false,
  };
}

function fromSrgb(rgb: Vec3, alpha: number, format: ColorFormat): ParsedColor {
  return {
    r: clamp(rgb[0], 0, 1),
    g: clamp(rgb[1], 0, 1),
    b: clamp(rgb[2], 0, 1),
    a: alpha,
    format,
    clipped: false,
  };
}

function fromOklch(lch: Vec3, alpha: number, format: ColorFormat): ParsedColor {
  const mapped = gamutMapOklch(lch[0], lch[1], lch[2]);
  const out: ParsedColor = {
    r: mapped.rgb[0],
    g: mapped.rgb[1],
    b: mapped.rgb[2],
    a: alpha,
    format,
    clipped: mapped.clipped,
  };
  if (mapped.clipped) {
    out.requestedChroma = Math.max(lch[1], 0);
    out.mappedChroma = mapped.chroma;
  }
  return out;
}

function fromLabD50(lab: Vec3, alpha: number, format: ColorFormat): ParsedColor {
  const lin = labD50ToLinear(lab);
  if (inGamut(lin)) return fromSrgb(encode(lin), alpha, format);
  return fromOklch(labToLch(linearToOklab(lin)), alpha, format);
}

/**
 * Parse any CSS color into normalized sRGB plus the syntax it was written in.
 *
 * Accepts hex in 3, 4, 6 and 8 digits (with or without the leading hash), the
 * legacy comma forms of rgb()/rgba()/hsl()/hsla(), the modern space separated
 * forms with an optional `/ alpha`, hwb(), lab(), lch(), oklab(), oklch(), the
 * `none` keyword for any component, and all 148 CSS color names. Colors
 * outside sRGB are gamut mapped by chroma reduction in OKLCH, and the result
 * reports that on `clipped`.
 */
export function parseColor(input: string): ParsedColor {
  const token = (input ?? "").trim();
  if (!token) throw emptyInput();
  const lower = token.toLowerCase();

  const named = NAMED_COLORS[lower];
  if (named) return { ...fromHex(named, token), format: "named" };

  if (lower.startsWith("#") || /^[0-9a-f]+$/.test(lower)) return fromHex(lower, token);

  const fn = /^([a-z]+)\(([^()]*)\)$/.exec(lower);
  if (!fn) throw badColor(token);
  const name = fn[1];
  const { parts, alpha: alphaTok } = splitFuncArgs(fn[2]);
  if (parts.length !== 3) throw badColor(token);
  const alpha = alphaTok === null ? 1 : readAlpha(alphaTok, token);

  switch (name) {
    case "rgb":
    case "rgba": {
      const channel = (tok: string): number => {
        const n = readNumber(tok, token);
        return clamp(n.percent ? n.value / 100 : n.value / 255, 0, 1);
      };
      return fromSrgb([channel(parts[0]), channel(parts[1]), channel(parts[2])], alpha, "rgb");
    }
    case "hsl":
    case "hsla": {
      const hsl: Vec3 = [
        readAngle(parts[0], token),
        clamp(readPercentish(parts[1], token), 0, 100),
        clamp(readPercentish(parts[2], token), 0, 100),
      ];
      return fromSrgb(hslToSrgb(hsl), alpha, "hsl");
    }
    case "hwb": {
      const hwb: Vec3 = [
        readAngle(parts[0], token),
        clamp(readPercentish(parts[1], token), 0, 100),
        clamp(readPercentish(parts[2], token), 0, 100),
      ];
      return fromSrgb(hwbToSrgb(hwb), alpha, "hwb");
    }
    case "lab": {
      const lab: Vec3 = [
        clamp(readPercentish(parts[0], token), 0, 100),
        readScaled(parts[1], token, 125),
        readScaled(parts[2], token, 125),
      ];
      return fromLabD50(lab, alpha, "lab");
    }
    case "lch": {
      const lch: Vec3 = [
        clamp(readPercentish(parts[0], token), 0, 100),
        Math.max(readScaled(parts[1], token, 150), 0),
        readAngle(parts[2], token),
      ];
      return fromLabD50(lchToLab(lch), alpha, "lch");
    }
    case "oklab": {
      const n = readNumber(parts[0], token);
      const lab: Vec3 = [
        clamp(n.percent ? n.value / 100 : n.value, 0, 1),
        readScaled(parts[1], token, 0.4),
        readScaled(parts[2], token, 0.4),
      ];
      return fromOklch(labToLch(lab), alpha, "oklab");
    }
    case "oklch": {
      const n = readNumber(parts[0], token);
      const lch: Vec3 = [
        clamp(n.percent ? n.value / 100 : n.value, 0, 1),
        Math.max(readScaled(parts[1], token, 0.4), 0),
        readAngle(parts[2], token),
      ];
      return fromOklch(lch, alpha, "oklch");
    }
    default:
      throw badColor(token);
  }
}

/* --------------------------------------------------------------- formatting */

/** Fixed decimals with trailing zeros trimmed, and no negative zero. */
export function num(v: number, dp: number): string {
  if (!Number.isFinite(v)) return "0";
  let s = v.toFixed(dp);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

/** Below this OKLCH chroma a color is treated as achromatic and its hue as `none`. */
const ACHROMATIC_OKLCH = 1e-4;
/** The same idea on the CIE chroma scale, which runs roughly 0..150. */
const ACHROMATIC_LCH = 0.01;

function alphaSuffix(a: number): string {
  return a < 1 ? ` / ${num(a, 3)}` : "";
}

function rgbVec(c: Rgba): Vec3 {
  return [c.r, c.g, c.b];
}

/** Lowercase #rrggbb, extended to #rrggbbaa only when the color is translucent. */
export function formatHex(c: Rgba): string {
  const hex = (v: number): string =>
    Math.round(clamp(v, 0, 1) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}${c.a < 1 ? hex(c.a) : ""}`;
}

/** Modern space separated `rgb()`, with 0..255 integers. */
export function formatRgb(c: Rgba): string {
  const ch = (v: number): string => String(Math.round(clamp(v, 0, 1) * 255));
  return `rgb(${ch(c.r)} ${ch(c.g)} ${ch(c.b)}${alphaSuffix(c.a)})`;
}

/** Modern space separated `hsl()`. */
export function formatHsl(c: Rgba): string {
  const [h, s, l] = srgbToHsl(rgbVec(c));
  return `hsl(${num(h, 2)} ${num(s, 2)}% ${num(l, 2)}%${alphaSuffix(c.a)})`;
}

/** `hwb()`, whiteness and blackness as percentages. */
export function formatHwb(c: Rgba): string {
  const [h, w, bl] = srgbToHwb(rgbVec(c));
  return `hwb(${num(h, 2)} ${num(w, 2)}% ${num(bl, 2)}%${alphaSuffix(c.a)})`;
}

/** `oklch()`. An achromatic color gets the CSS `none` hue rather than a made up angle. */
export function formatOklch(c: Rgba): string {
  const [l, ch, h] = srgbToOklch(rgbVec(c));
  const hue = ch < ACHROMATIC_OKLCH ? "none" : num(h, 2);
  return `oklch(${num(l, 3)} ${num(ch, 4)} ${hue}${alphaSuffix(c.a)})`;
}

/** `oklab()`. */
export function formatOklab(c: Rgba): string {
  const [l, a, b] = srgbToOklab(rgbVec(c));
  return `oklab(${num(l, 3)} ${num(a, 4)} ${num(b, 4)}${alphaSuffix(c.a)})`;
}

/** CIE `lab()` under D50, the white point CSS Color 4 defines for this function. */
export function formatLab(c: Rgba): string {
  const [l, a, b] = srgbToLabD50(rgbVec(c));
  return `lab(${num(l, 2)} ${num(a, 2)} ${num(b, 2)}${alphaSuffix(c.a)})`;
}

/** CIE `lch()` under D50. An achromatic color gets the CSS `none` hue. */
export function formatLch(c: Rgba): string {
  const [l, ch, h] = srgbToLchD50(rgbVec(c));
  const hue = ch < ACHROMATIC_LCH ? "none" : num(h, 2);
  return `lch(${num(l, 2)} ${num(ch, 2)} ${hue}${alphaSuffix(c.a)})`;
}

/* ----------------------------------------------------------------- WCAG */

/** WCAG 2.x relative luminance of a gamma encoded sRGB triple. */
export function relativeLuminance(rgb: Vec3): number {
  const lin = decode([clamp(rgb[0], 0, 1), clamp(rgb[1], 0, 1), clamp(rgb[2], 0, 1)]);
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG 2.x contrast ratio, from 1:1 to 21:1. Order of the arguments does not matter. */
export function contrastRatio(a: Vec3, b: Vec3): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/* --------------------------------------------------------- input splitting */

/**
 * Split an input into color operands on top level commas, newlines,
 * semicolons and the word "on", leaving anything inside parentheses alone so
 * "rgb(255, 0, 0) on white" survives.
 */
export function splitOperands(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0) {
      if (ch === "," || ch === ";" || ch === "\n") {
        parts.push(current);
        current = "";
        continue;
      }
      const after = raw[i + 2];
      const isOn =
        (ch === "o" || ch === "O") &&
        /\s/.test(raw[i - 1] ?? "") &&
        /[nN]/.test(raw[i + 1] ?? "") &&
        (after === undefined || /\s/.test(after));
      if (isOn) {
        parts.push(current);
        current = "";
        i += 2;
        continue;
      }
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim());
}

/** The WCAG 2.x thresholds this tool reports, in the order it reports them. */
export const WCAG_THRESHOLDS: readonly {
  id: string;
  label: string;
  min: number;
  note: string;
}[] = [
  {
    id: "aa-normal",
    label: "AA normal text",
    min: 4.5,
    note: "body text below 18pt, or below 14pt bold",
  },
  {
    id: "aa-large",
    label: "AA large text",
    min: 3,
    note: "18pt and up, or 14pt bold and up",
  },
  {
    id: "aa-ui",
    label: "AA user interface",
    min: 3,
    note: "icons, form borders, focus rings, chart keys",
  },
  { id: "aaa-normal", label: "AAA normal text", min: 7, note: "the enhanced level for body text" },
  { id: "aaa-large", label: "AAA large text", min: 4.5, note: "the enhanced level for headings" },
];

export interface WcagCheck {
  id: string;
  label: string;
  min: number;
  note: string;
  pass: boolean;
}

/** Pass or fail against every threshold above, at a given ratio. */
export function wcagChecks(ratio: number): WcagCheck[] {
  return WCAG_THRESHOLDS.map((t) => ({ ...t, pass: ratio + 1e-9 >= t.min }));
}

/** The ratio a named threshold needs, used as the target for a suggestion. */
export function thresholdRatio(id: string): number {
  return WCAG_THRESHOLDS.find((t) => t.id === id)?.min ?? 4.5;
}

/* ----------------------------------------------------------------- APCA */

/**
 * APCA 0.1.9 (the APCA-W3 constants), the perceptual contrast model behind the
 * WCAG 3 drafts. It is not a ratio and it is not symmetric: the sign carries
 * the polarity, so dark text on a light background gives a positive Lc and
 * light text on a dark background gives a negative one. Only the magnitude is
 * compared against the guidance levels.
 *
 * Two anchors, both reproduced by the code below: black on white is Lc 106.0,
 * and white on black is Lc -107.9.
 */
const APCA_MAIN_TRC = 2.4;
const APCA_R = 0.2126729;
const APCA_G = 0.7151522;
const APCA_B = 0.072175;
const APCA_NORM_BG = 0.56;
const APCA_NORM_TEXT = 0.57;
const APCA_REV_TEXT = 0.62;
const APCA_REV_BG = 0.65;
const APCA_BLACK_THRESHOLD = 0.022;
const APCA_BLACK_CLAMP = 1.414;
const APCA_SCALE = 1.14;
const APCA_LOW_THRESHOLD = 0.035991;
const APCA_LOW_FACTOR = 27.7847239587675;
const APCA_LOW_OFFSET = 0.027;
const APCA_DELTA_Y_MIN = 0.0005;
const APCA_LOW_CLIP = 0.001;

/**
 * APCA screen luminance Y. This is not the WCAG relative luminance: APCA uses a
 * plain 2.4 power curve with no linear toe, which is why the two models
 * disagree most about very dark colors.
 */
export function apcaLuminance(rgb: Vec3): number {
  const ch = (v: number): number => Math.pow(clamp(v, 0, 1), APCA_MAIN_TRC);
  return APCA_R * ch(rgb[0]) + APCA_G * ch(rgb[1]) + APCA_B * ch(rgb[2]);
}

/** Soft clamp for near black, so two nearly black colors do not report a huge Lc. */
function apcaClampBlack(y: number): number {
  return y > APCA_BLACK_THRESHOLD ? y : y + Math.pow(APCA_BLACK_THRESHOLD - y, APCA_BLACK_CLAMP);
}

/** APCA lightness contrast Lc. Text first, background second: order matters. */
export function apcaLc(text: Vec3, background: Vec3): number {
  const textY = apcaClampBlack(apcaLuminance(text));
  const bgY = apcaClampBlack(apcaLuminance(background));
  if (Math.abs(bgY - textY) < APCA_DELTA_Y_MIN) return 0;

  let sapc: number;
  let output: number;
  if (bgY > textY) {
    // Normal polarity: dark text on a light background.
    sapc = (Math.pow(bgY, APCA_NORM_BG) - Math.pow(textY, APCA_NORM_TEXT)) * APCA_SCALE;
    output =
      sapc < APCA_LOW_CLIP
        ? 0
        : sapc < APCA_LOW_THRESHOLD
          ? sapc - sapc * APCA_LOW_FACTOR * APCA_LOW_OFFSET
          : sapc - APCA_LOW_OFFSET;
  } else {
    // Reverse polarity: light text on a dark background.
    sapc = (Math.pow(bgY, APCA_REV_BG) - Math.pow(textY, APCA_REV_TEXT)) * APCA_SCALE;
    output =
      sapc > -APCA_LOW_CLIP
        ? 0
        : sapc > -APCA_LOW_THRESHOLD
          ? sapc - sapc * APCA_LOW_FACTOR * APCA_LOW_OFFSET
          : sapc + APCA_LOW_OFFSET;
  }
  return output * 100;
}

/**
 * The rough APCA readability levels, highest first. These are the working
 * thresholds from the APCA readability criteria, not a ratified standard: WCAG
 * 3 is still a draft, so treat them as guidance rather than as something to
 * certify against.
 */
export const APCA_LEVELS: readonly { min: number; label: string }[] = [
  { min: 90, label: "Preferred for body text at any weight or size" },
  { min: 75, label: "Minimum for body text around 18px at weight 400" },
  { min: 60, label: "Minimum for content text around 24px, or 16px bold" },
  { min: 45, label: "Minimum for headings around 36px, or 24px bold" },
  { min: 30, label: "The floor for any readable text, including placeholders" },
  { min: 15, label: "Non text only: icons, dividers, and disabled states" },
];

/** The guidance line for an Lc value, read off its magnitude. */
export function apcaGuidance(lc: number): string {
  const magnitude = Math.abs(lc);
  const level = APCA_LEVELS.find((l) => magnitude >= l.min);
  return level ? level.label : "Below Lc 15: invisible in practice, so use it for nothing";
}

/* ------------------------------------------------------- alpha compositing */

/**
 * Composite a translucent color over an opaque one, in gamma encoded sRGB. A
 * browser blends in that same encoded space, so this matches what a visitor
 * actually sees rather than what a linear light blend would predict.
 */
export function compositeOver(fg: Rgba, bg: Rgba): Rgba {
  const a = clamp(fg.a, 0, 1);
  if (a >= 1) return { ...fg, a: 1 };
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

/* ------------------------------------------------------------ suggestions */

export interface Suggestion {
  /** The suggested foreground as #rrggbb. */
  hex: string;
  /** Its `oklch()` form, which is how the change was actually made. */
  oklch: string;
  /** WCAG ratio the suggestion reaches. */
  ratio: number;
  /** APCA Lc the suggestion reaches. */
  lc: number;
  /** Whether it is lighter or darker than the color you gave. */
  direction: "lighter" | "darker";
  /** How far the OKLCH lightness moved, on the 0..1 OKLCH scale. */
  lightnessShift: number;
}

function rgbaOf(rgb: Vec3): Rgba {
  return { r: rgb[0], g: rgb[1], b: rgb[2], a: 1 };
}

/** The ratio a candidate lightness reaches, with chroma and hue held fixed. */
function ratioAtLightness(l: number, c: number, h: number, bg: Vec3): number {
  return contrastRatio(candidateAt(l, c, h), bg);
}

/**
 * The suggestion at one OKLCH lightness, rounded to the eight bits per channel
 * a hex value can hold.
 *
 * The search runs on the rounded color rather than the continuous one on
 * purpose. Without it the answer is a lightness that passes in floating point
 * and then fails once it is written as #rrggbb, which is exactly how a
 * suggestion tool ends up handing back the color you already had.
 *
 * A color with no chroma is rounded to one shared level instead of three
 * independent ones: the OKLab matrices are not exactly reversible, so a gray
 * round trips with channels a hair apart, and near a rounding boundary that
 * turns #767676 into #777676.
 */
function candidateAt(l: number, c: number, h: number): Vec3 {
  const rgb = gamutMapOklch(clamp(l, 0, 1), c, h).rgb;
  const to8 = (v: number): number => Math.round(clamp(v, 0, 1) * 255) / 255;
  if (c < ACHROMATIC_OKLCH) {
    const level = to8((rgb[0] + rgb[1] + rgb[2]) / 3);
    return [level, level, level];
  }
  return [to8(rgb[0]), to8(rgb[1]), to8(rgb[2])];
}

/**
 * The nearest foreground that reaches `target`, found by moving OKLCH lightness
 * while holding chroma and hue. Lightness is the axis that moves contrast
 * without changing the color's identity, and holding hue is what keeps a brand
 * color recognizable. Chroma that no longer fits inside sRGB at the new
 * lightness is reduced by the same gamut mapping the parser uses.
 *
 * Returns null when the pair already passes, and when neither direction can
 * reach the target, which happens on a mid gray background: its ceiling against
 * both black and white is well under 21:1.
 */
export function suggestForeground(fg: Rgba, bg: Rgba, target: number): Suggestion | null {
  const bgVec: Vec3 = [bg.r, bg.g, bg.b];
  const fgVec: Vec3 = [fg.r, fg.g, fg.b];
  if (contrastRatio(fgVec, bgVec) + 1e-9 >= target) return null;

  const [l0, c, h] = srgbToOklch(fgVec);

  /** Binary search between the failing start and a passing limit. */
  const search = (limit: number): number | null => {
    if (ratioAtLightness(limit, c, h, bgVec) + 1e-9 < target) return null;
    let fail = l0;
    let pass = limit;
    for (let i = 0; i < 40; i++) {
      const mid = (fail + pass) / 2;
      if (ratioAtLightness(mid, c, h, bgVec) + 1e-9 >= target) pass = mid;
      else fail = mid;
    }
    return pass;
  };

  const darker = search(0);
  const lighter = search(1);
  let chosen: number | null = null;
  let direction: "lighter" | "darker" = "darker";
  if (darker !== null && lighter !== null) {
    if (Math.abs(l0 - darker) <= Math.abs(lighter - l0)) {
      chosen = darker;
    } else {
      chosen = lighter;
      direction = "lighter";
    }
  } else if (darker !== null) {
    chosen = darker;
  } else if (lighter !== null) {
    chosen = lighter;
    direction = "lighter";
  }
  if (chosen === null) return null;

  const mapped = candidateAt(chosen, c, h);
  const color = rgbaOf(mapped);
  return {
    hex: formatHex(color),
    oklch: formatOklch(color),
    ratio: contrastRatio(mapped, bgVec),
    lc: apcaLc(mapped, bgVec),
    direction,
    lightnessShift: Math.abs(chosen - l0),
  };
}

/* ----------------------------------------------------------------- report */

export interface ContrastReport {
  foreground: Rgba;
  background: Rgba;
  /** The foreground actually measured, after any alpha was composited away. */
  effectiveForeground: Rgba;
  /** The background actually measured, after any alpha was composited over white. */
  effectiveBackground: Rgba;
  /** True when either input carried alpha and had to be flattened first. */
  composited: boolean;
  ratio: number;
  checks: WcagCheck[];
  lc: number;
  guidance: string;
  /** Present only when the pair misses the requested threshold. */
  suggestion: Suggestion | null;
  /** The threshold the suggestion was aimed at. */
  target: { id: string; label: string; min: number };
}

/** White, the surface a translucent background is assumed to sit on. */
const PAPER: Rgba = { r: 1, g: 1, b: 1, a: 1 };

/** Everything the panel and the text report both need, computed once. */
export function analyzePair(
  foreground: Rgba,
  background: Rgba,
  targetId = "aa-normal",
): ContrastReport {
  const effectiveBackground = compositeOver(background, PAPER);
  const effectiveForeground = compositeOver(foreground, effectiveBackground);
  const fgVec: Vec3 = [effectiveForeground.r, effectiveForeground.g, effectiveForeground.b];
  const bgVec: Vec3 = [effectiveBackground.r, effectiveBackground.g, effectiveBackground.b];
  const ratio = contrastRatio(fgVec, bgVec);
  const lc = apcaLc(fgVec, bgVec);
  const target = WCAG_THRESHOLDS.find((t) => t.id === targetId) ?? WCAG_THRESHOLDS[0];
  return {
    foreground,
    background,
    effectiveForeground,
    effectiveBackground,
    composited: foreground.a < 1 || background.a < 1,
    ratio,
    checks: wcagChecks(ratio),
    lc,
    guidance: apcaGuidance(lc),
    suggestion: suggestForeground(effectiveForeground, effectiveBackground, target.min),
    target: { id: target.id, label: target.label, min: target.min },
  };
}

/* -------------------------------------------------------------------- run */

export interface ContrastOpts {
  foreground?: string;
  background?: string;
  target?: string;
  [key: string]: unknown;
}

function optText(opts: ContrastOpts | undefined, key: string): string {
  const raw = opts?.[key];
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Read the foreground and the background out of the input, the options, or
 * both. The input is a shorthand: "#333 on #fff", "#333, #fff", or the two
 * colors on their own lines. Whatever it does not supply falls back to the
 * option boxes.
 */
export function readPair(
  input: string,
  opts: ContrastOpts,
): { foreground: string; background: string } {
  const tokens = splitOperands(input ?? "").filter((t) => t.length > 0);
  const foreground = tokens[0] ?? optText(opts, "foreground");
  const background = tokens[1] ?? optText(opts, "background");
  if (!foreground || !background) {
    throw new ToolError(
      "missing-pair",
      "A contrast check needs two colors: the text color and the surface behind it.",
      'Fill in both boxes, or type a pair like "#333 on #fff" in the quick entry field.',
    );
  }
  return { foreground, background };
}

function ratioText(ratio: number): string {
  return `${ratio.toFixed(2)}:1`;
}

export function run(input: string | Uint8Array, opts: ContrastOpts = {}): Record<string, string> {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);
  const pair = readPair(text, opts);
  const foreground = parseColor(pair.foreground);
  const background = parseColor(pair.background);
  const report = analyzePair(foreground, background, optText(opts, "target") || "aa-normal");

  const out: Record<string, string> = {
    Foreground: `${formatHex(report.effectiveForeground)} (${pair.foreground.trim()})`,
    Background: `${formatHex(report.effectiveBackground)} (${pair.background.trim()})`,
    "Contrast ratio": ratioText(report.ratio),
  };
  if (report.composited) {
    out["Alpha"] =
      "One of the colors was translucent, so it was flattened before measuring: the foreground over the background, and the background over white.";
  }
  for (const check of report.checks) {
    out[check.label] =
      `${check.pass ? "Pass" : "Fail"}, needs ${check.min.toFixed(1)}:1 (${check.note})`;
  }
  out["APCA Lc"] =
    `${report.lc.toFixed(1)} (${report.lc >= 0 ? "dark text on a light surface" : "light text on a dark surface"})`;
  out["APCA guidance"] = report.guidance;

  if (report.suggestion) {
    const s = report.suggestion;
    out[`Nearest passing foreground for ${report.target.label}`] =
      `${s.hex}, ${ratioText(s.ratio)}, ${s.direction} than the color you gave`;
    out["Suggested foreground in OKLCH"] = s.oklch;
  } else {
    out[`Meets ${report.target.label}`] = "Yes, no change needed.";
  }
  return out;
}

export default { run } satisfies ToolLogic<
  string | Uint8Array,
  Record<string, string>,
  ContrastOpts
>;
