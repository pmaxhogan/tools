import { ToolError, type ToolLogic } from "../types";

/** A color vision deficiency the simulator can model. */
export type CvdKind =
  | "protanopia"
  | "protanomaly"
  | "deuteranopia"
  | "deuteranomaly"
  | "tritanopia"
  | "tritanomaly"
  | "achromatopsia";

/** Every deficiency, in the order rows are reported. */
export const CVD_KINDS: readonly CvdKind[] = [
  "protanopia",
  "protanomaly",
  "deuteranopia",
  "deuteranomaly",
  "tritanopia",
  "tritanomaly",
  "achromatopsia",
] as const;

/** Row major 3x3 matrix applied in linear RGB. */
export type Matrix3 = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
];

/**
 * Machado, Oliveira and Fernandes (2009) color vision deficiency matrices,
 * plus a Rec. 709 luminance matrix for achromatopsia.
 *
 * The dichromacy entries (protanopia, deuteranopia, tritanopia) are the
 * severity 1.0 rows of the published table; the anomalous trichromacy entries
 * (protanomaly, deuteranomaly, tritanomaly) are the severity 0.5 rows. Every
 * matrix operates on linear RGB, never on gamma encoded sRGB.
 */
export const MATRICES: Readonly<Record<CvdKind, Matrix3>> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  protanomaly: [
    [0.458064, 0.679578, -0.137642],
    [0.092785, 0.846313, 0.060902],
    [-0.007494, -0.016807, 1.024301],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  deuteranomaly: [
    [0.547494, 0.607765, -0.155259],
    [0.181692, 0.781742, 0.036566],
    [-0.01041, 0.027275, 0.983136],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
  tritanomaly: [
    [1.017277, 0.027029, -0.044306],
    [-0.006113, 0.958479, 0.047634],
    [0.006379, 0.248708, 0.744913],
  ],
  achromatopsia: [
    [0.2126, 0.7152, 0.0722],
    [0.2126, 0.7152, 0.0722],
    [0.2126, 0.7152, 0.0722],
  ],
};

/** CIE76 deltaE below this reads as "hard to tell apart" for palette work. */
export const HARD_TO_DISTINGUISH_DELTA_E = 12;

export interface ColorBlindnessOpts {
  /** One of CVD_KINDS, or "all" for every deficiency at once. */
  kind: string;
  /** Report WCAG contrast and CIE76 deltaE for adjacent palette pairs. */
  contrast: boolean;
  [key: string]: unknown;
}

export type ColorBlindnessResult = Record<string, string>;

type Rgb = [number, number, number];

/* ------------------------------------------------------------------ parsing */

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const FUNC_RE = /^rgba?\(([^)]*)\)$/i;

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function badColor(token: string): ToolError {
  return new ToolError(
    "bad-color",
    `Could not read "${token}" as a color.`,
    "Use #rgb, #rrggbb, a bare 6 digit hex like ff8800, or rgb(255, 136, 0). Put one color per line or separate them with commas.",
  );
}

/** Parse one color token into a 0..255 RGB triple. Accepts #rgb, #rrggbb, bare hex, rgb(). */
export function parseColor(s: string): Rgb {
  const token = (s ?? "").trim();
  if (!token) throw badColor(s ?? "");

  const fn = FUNC_RE.exec(token);
  if (fn) {
    const parts = fn[1]
      .split(/[,/\s]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length < 3) throw badColor(token);
    const nums: number[] = [];
    for (let i = 0; i < 3; i++) {
      const p = parts[i];
      const pct = p.endsWith("%");
      const n = Number(pct ? p.slice(0, -1) : p);
      if (!Number.isFinite(n)) throw badColor(token);
      nums.push(clamp(Math.round(pct ? (n / 100) * 255 : n), 0, 255));
    }
    return [nums[0], nums[1], nums[2]];
  }

  const hex = HEX_RE.exec(token);
  if (!hex) throw badColor(token);
  const body = hex[1];
  if (body.length === 3) {
    return [
      parseInt(body[0] + body[0], 16),
      parseInt(body[1] + body[1], 16),
      parseInt(body[2] + body[2], 16),
    ];
  }
  return [
    parseInt(body.slice(0, 2), 16),
    parseInt(body.slice(2, 4), 16),
    parseInt(body.slice(4, 6), 16),
  ];
}

/** Split a palette blob into color tokens, keeping rgb(...) groups intact. */
function tokenize(input: string): string[] {
  const out: string[] = [];
  const re = /rgba?\([^)]*\)?|[^\s,;]+/gi;
  let m: RegExpExecArray | null = re.exec(input);
  while (m !== null) {
    out.push(m[0]);
    m = re.exec(input);
  }
  return out;
}

/* ------------------------------------------------------------ color science */

/** sRGB transfer function: gamma encoded 0..1 to linear 0..1. */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Inverse sRGB transfer function: linear 0..1 to gamma encoded 0..1. */
function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function toLinear(rgb: Rgb): [number, number, number] {
  return [
    srgbToLinear(clamp(rgb[0], 0, 255) / 255),
    srgbToLinear(clamp(rgb[1], 0, 255) / 255),
    srgbToLinear(clamp(rgb[2], 0, 255) / 255),
  ];
}

/**
 * Simulate one color under a deficiency. Input and output are 0..255 sRGB
 * triples: decode to linear, apply the 3x3 matrix, clamp, re-encode.
 */
export function simulateRgb(rgb: Rgb, kind: CvdKind): Rgb {
  const m = MATRICES[kind];
  if (!m) {
    throw new ToolError(
      "bad-kind",
      `Unknown deficiency "${String(kind)}".`,
      `Pick one of: ${CVD_KINDS.join(", ")}.`,
    );
  }
  const lin = toLinear(rgb);
  const out: number[] = [];
  for (let row = 0; row < 3; row++) {
    const v = m[row][0] * lin[0] + m[row][1] * lin[1] + m[row][2] * lin[2];
    out.push(Math.round(linearToSrgb(clamp(v, 0, 1)) * 255));
  }
  return [out[0], out[1], out[2]];
}

/** Format a 0..255 RGB triple as lowercase #rrggbb. */
export function toHex(rgb: Rgb): string {
  return "#" + rgb.map((c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, "0")).join("");
}

/** WCAG relative luminance of a 0..255 sRGB triple. */
function luminance(rgb: Rgb): number {
  const [r, g, b] = toLinear(rgb);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two 0..255 sRGB triples. */
function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function toLab(rgb: Rgb): [number, number, number] {
  const [r, g, b] = toLinear(rgb);
  // Linear sRGB to CIE XYZ, D65.
  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(x / 0.95047);
  const fy = f(y);
  const fz = f(z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 color difference between two 0..255 sRGB triples. */
function deltaE76(a: Rgb, b: Rgb): number {
  const la = toLab(a);
  const lb = toLab(b);
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

/* ------------------------------------------------------------------- output */

function fmtRatio(n: number): string {
  return `${n.toFixed(2)}:1`;
}

function fmtDelta(n: number): string {
  return n.toFixed(1);
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function assertKind(kind: string): CvdKind {
  if ((CVD_KINDS as readonly string[]).includes(kind)) return kind as CvdKind;
  throw new ToolError(
    "bad-kind",
    `Unknown deficiency "${kind}".`,
    `Pick "all" or one of: ${CVD_KINDS.join(", ")}.`,
  );
}

export function run(input: string, opts: ColorBlindnessOpts): ColorBlindnessResult {
  const raw = (input ?? "").trim();
  const tokens = raw ? tokenize(raw) : [];
  if (tokens.length === 0) {
    throw new ToolError(
      "empty-input",
      "Enter at least one color to simulate.",
      "Paste a palette with one color per line, such as #1d4ed8 or rgb(29, 78, 216).",
    );
  }

  const colors = tokens.map((t) => parseColor(t));
  const hexes = colors.map(toHex);

  const kindOpt = String(opts?.kind ?? "all");
  const wantAll = kindOpt === "all";
  const kinds: CvdKind[] = wantAll ? [...CVD_KINDS] : [assertKind(kindOpt)];
  const showContrast = opts?.contrast !== false;

  const simulated: Record<string, Rgb[]> = {};
  for (const kind of kinds) simulated[kind] = colors.map((c) => simulateRgb(c, kind));

  const out: ColorBlindnessResult = {};

  colors.forEach((_, i) => {
    const key = `Color ${i + 1} (${hexes[i]})`;
    out[key] = wantAll
      ? kinds.map((k) => `${k} ${toHex(simulated[k][i])}`).join(" | ")
      : `${hexes[i]} -> ${toHex(simulated[kinds[0]][i])}`;
  });

  const warnings: string[] = [];

  if (showContrast && colors.length >= 2) {
    for (let i = 0; i + 1 < colors.length; i++) {
      const a = colors[i];
      const b = colors[i + 1];
      const label = `Pair ${i + 1} and ${i + 2} (${hexes[i]}, ${hexes[i + 1]})`;
      const before = `original contrast ${fmtRatio(contrastRatio(a, b))}, deltaE ${fmtDelta(
        deltaE76(a, b),
      )}`;

      const parts = kinds.map((k) => {
        const sa = simulated[k][i];
        const sb = simulated[k][i + 1];
        const d = deltaE76(sa, sb);
        const flagged = d < HARD_TO_DISTINGUISH_DELTA_E;
        if (flagged) warnings.push(`pair ${i + 1} and ${i + 2} under ${k}`);
        return `${k} contrast ${fmtRatio(contrastRatio(sa, sb))}, deltaE ${fmtDelta(d)}${
          flagged ? ", hard to tell apart" : ""
        }`;
      });

      out[label] = [before, ...parts].join(" | ");
    }
  } else if (showContrast) {
    out["Contrast check"] = "Add a second color to compare adjacent pairs.";
  }

  if (showContrast) {
    out["Warnings"] =
      warnings.length === 0
        ? "None. Every adjacent pair stays distinguishable under the simulations shown."
        : `${warnings.length} ${plural(
            warnings.length,
            "pair becomes",
            "pairs become",
          )} hard to tell apart (CIE76 deltaE under ${HARD_TO_DISTINGUISH_DELTA_E}): ${warnings.join(
            "; ",
          )}.`;
  }

  out["Summary"] = `${colors.length} ${plural(colors.length, "color", "colors")} simulated as ${
    wantAll ? "all seven deficiencies" : kinds[0]
  }, using the Machado 2009 matrices in linear RGB.`;

  return out;
}

export default { run } satisfies ToolLogic<string, ColorBlindnessResult, ColorBlindnessOpts>;
