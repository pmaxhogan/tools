import { ToolError, type ToolLogic } from "../types";

export interface LcResonanceOpts {
  [key: string]: unknown;
}

export type LcResonanceResult = Record<string, string>;

const IND_SUFFIXES: { suf: string; toH: number }[] = [
  { suf: "nh", toH: 1e-9 },
  { suf: "uh", toH: 1e-6 },
  { suf: "µh", toH: 1e-6 },
  { suf: "mh", toH: 1e-3 },
  { suf: "h", toH: 1 },
];

const CAP_SUFFIXES: { suf: string; toF: number }[] = [
  { suf: "pf", toF: 1e-12 },
  { suf: "nf", toF: 1e-9 },
  { suf: "uf", toF: 1e-6 },
  { suf: "µf", toF: 1e-6 },
  { suf: "mf", toF: 1e-3 },
  { suf: "f", toF: 1 },
];

const FREQ_SUFFIXES: { suf: string; mult: number }[] = [
  { suf: "ghz", mult: 1e9 },
  { suf: "mhz", mult: 1e6 },
  { suf: "khz", mult: 1e3 },
  { suf: "hz", mult: 1 },
];

function parseWithSuffixes(
  raw: string,
  table: { suf: string; toH?: number; toF?: number; mult?: number }[],
  kind: "inductance" | "capacitance" | "frequency",
): number {
  const compact = raw.toLowerCase().replace(/\s+/g, "");
  for (const entry of table) {
    if (compact.endsWith(entry.suf)) {
      const num = Number(compact.slice(0, -entry.suf.length));
      if (num === undefined || Number.isNaN(num)) {
        throw new ToolError(
          "bad-token",
          `Could not parse "${raw}" as ${kind}.`,
          "Use a number followed by a unit.",
        );
      }
      const factor = entry.toH ?? entry.toF ?? entry.mult ?? 1;
      return num * factor;
    }
  }
  throw new ToolError(
    "bad-token",
    `Could not recognize a unit in "${raw}" for ${kind}.`,
    kind === "inductance"
      ? "Use nH, uH, mH, or H, like 10uH."
      : kind === "capacitance"
        ? "Use pF, nF, uF, mF, or F, like 100pF."
        : "Use Hz, kHz, MHz, or GHz, like 7.1MHz.",
  );
}

function parseInductanceH(raw: string): number {
  return parseWithSuffixes(raw, IND_SUFFIXES, "inductance");
}
function parseCapacitanceF(raw: string): number {
  return parseWithSuffixes(raw, CAP_SUFFIXES, "capacitance");
}
function parseFrequencyHz(raw: string): number {
  return parseWithSuffixes(raw, FREQ_SUFFIXES, "frequency");
}
/** Series resistance for the Q / bandwidth option. Supports a bare number of ohms or a kilo-ohm suffix. */
function parseResistanceOhm(raw: string): number {
  const compact = raw.replace(/\s+/g, "");
  const m = compact.match(/^([\d.]+)(k|K)?(ohms?|Ω)?$/);
  if (!m || m[1] === "") {
    throw new ToolError(
      "bad-token",
      `Could not parse "${raw}" as a resistance.`,
      "Use a plain number of ohms, or a k suffix for kilo-ohms, like 50 or 4.7k.",
    );
  }
  const num = Number(m[1]);
  if (!Number.isFinite(num)) {
    throw new ToolError(
      "bad-token",
      `Could not parse "${raw}" as a resistance.`,
      "Use a plain number of ohms.",
    );
  }
  const mult = m[2] ? 1e3 : 1;
  return num * mult;
}

function formatEng(value: number, unit: string): string {
  if (!Number.isFinite(value)) return `${value} ${unit}`;
  if (value === 0) return `0 ${unit}`;
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const scales = [
    { exp: -12, suf: "p" },
    { exp: -9, suf: "n" },
    { exp: -6, suf: "u" },
    { exp: -3, suf: "m" },
    { exp: 0, suf: "" },
    { exp: 3, suf: "k" },
    { exp: 6, suf: "M" },
    { exp: 9, suf: "G" },
  ];
  let choice = scales[scales.length - 1];
  let found = false;
  for (const s of scales) {
    const scaled = abs / 10 ** s.exp;
    if (scaled >= 1 && scaled < 1000) {
      choice = s;
      found = true;
      break;
    }
  }
  if (!found && abs < 10 ** scales[0].exp) choice = scales[0];
  const scaled = abs / 10 ** choice.exp;
  const decimals = scaled < 10 ? 3 : scaled < 100 ? 2 : 1;
  return `${sign}${scaled.toFixed(decimals)} ${choice.suf}${unit}`;
}

interface Fields {
  L?: number; // henries
  C?: number; // farads
  F?: number; // hertz
  R?: number; // ohms
}

const KEY_MAP: Record<string, keyof Fields> = {
  l: "L",
  ind: "L",
  inductance: "L",
  c: "C",
  cap: "C",
  capacitance: "C",
  f: "F",
  freq: "F",
  frequency: "F",
  r: "R",
  res: "R",
  resistance: "R",
};

function parseInput(raw: string): Fields {
  const s = (raw ?? "").trim();
  if (!s) {
    throw new ToolError(
      "empty-input",
      'Enter two of L, C, or f, like "L=10uH C=100pF".',
      'Try "L=10uH C=100pF", "L=10uH f=7.1MHz", or "C=100pF f=7.1MHz", optionally with R=50 for Q and bandwidth.',
    );
  }
  const tokens = s.split(/[\s,]+/).filter(Boolean);
  const fields: Fields = {};

  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq <= 0) {
      throw new ToolError(
        "bad-token",
        `Could not read "${token}": use key=value pairs.`,
        'Try "L=10uH C=100pF" or "L=10uH f=7.1MHz R=50".',
      );
    }
    const key = token.slice(0, eq).toLowerCase();
    const val = token.slice(eq + 1);
    const field = KEY_MAP[key];
    if (!field) {
      throw new ToolError(
        "bad-token",
        `Unrecognized key "${key}" in "${token}".`,
        "Use L, C, f, or R.",
      );
    }
    if (field === "L") fields.L = parseInductanceH(val);
    else if (field === "C") fields.C = parseCapacitanceF(val);
    else if (field === "F") fields.F = parseFrequencyHz(val);
    else fields.R = parseResistanceOhm(val);
  }
  return fields;
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ToolError(
      "impossible",
      `${name} must be a positive number, got ${value}.`,
      `Provide a positive value for ${name}.`,
    );
  }
}

export function run(input: string, opts: LcResonanceOpts): LcResonanceResult {
  void opts;
  const fields = parseInput(input);
  const given: (keyof Fields)[] = (["L", "C", "F"] as const).filter((k) => fields[k] !== undefined);

  if (given.length < 2) {
    throw new ToolError(
      "need-two",
      `Provide at least two of L, C, or f. Got ${given.length === 0 ? "none" : given.join(", ")}.`,
      'Try "L=10uH C=100pF" to find f, "L=10uH f=7.1MHz" to find C, or "C=100pF f=7.1MHz" to find L.',
    );
  }

  let L: number;
  let C: number;
  let f: number;

  if (fields.L !== undefined && fields.C !== undefined) {
    assertPositive("L", fields.L);
    assertPositive("C", fields.C);
    L = fields.L;
    C = fields.C;
    f = 1 / (2 * Math.PI * Math.sqrt(L * C));
  } else if (fields.L !== undefined && fields.F !== undefined) {
    assertPositive("L", fields.L);
    assertPositive("f", fields.F);
    L = fields.L;
    f = fields.F;
    C = 1 / (4 * Math.PI * Math.PI * f * f * L);
  } else {
    assertPositive("C", fields.C as number);
    assertPositive("f", fields.F as number);
    C = fields.C as number;
    f = fields.F as number;
    L = 1 / (4 * Math.PI * Math.PI * f * f * C);
  }

  if (given.length === 3) {
    const computedF = 1 / (2 * Math.PI * Math.sqrt(L * C));
    const relErr = Math.abs(computedF - (fields.F as number)) / Math.max(computedF, 1e-9);
    if (relErr > 0.01) {
      throw new ToolError(
        "impossible",
        `Given frequency (${formatEng(fields.F as number, "Hz")}) does not match the resonant frequency computed from L and C (${formatEng(computedF, "Hz")}), off by ${(relErr * 100).toFixed(1)}%.`,
        "Only two of L, C, and f are independent; drop one of them.",
      );
    }
  }

  // At resonance XL and XC are equal by construction (that equality is what
  // defines the resonant frequency), so only one needs computing.
  const xl = 2 * Math.PI * f * L;

  const out: LcResonanceResult = {};
  out["Inductance"] = formatEng(L, "H");
  out["Capacitance"] = formatEng(C, "F");
  out["Resonant frequency"] = formatEng(f, "Hz");
  out["Reactance at resonance (XL = XC)"] = formatEng(xl, "ohm");
  out["Formula"] = "f = 1 / (2 pi sqrt(L x C)); XL = 2 pi f L; XC = 1 / (2 pi f C)";

  if (fields.R !== undefined) {
    assertPositive("R", fields.R);
    const R = fields.R;
    const q = xl / R;
    const bandwidth = f / q;
    out["Series resistance"] = formatEng(R, "ohm");
    out["Q factor"] = q.toFixed(3);
    out["Bandwidth (-3dB, series RLC)"] = formatEng(bandwidth, "Hz");
    out["Bandwidth formula"] = "Q = XL / R; bandwidth = f / Q";
  }

  return out;
}

export default { run } satisfies ToolLogic<string, LcResonanceResult, LcResonanceOpts>;

// Exported for tests only; not part of the tool's public logic surface.
export const __test__ = {
  parseInductanceH,
  parseCapacitanceF,
  parseFrequencyHz,
  parseResistanceOhm,
  formatEng,
};
