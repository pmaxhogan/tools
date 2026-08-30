import { ToolError, type ToolLogic } from "../types";

export interface LedResistorOpts {
  /** "red" | "green" | "blue-white" | "ir" | "uv" | "custom" */
  color: string;
  [key: string]: unknown;
}

export type LedResistorResult = Record<string, string>;

interface Fields {
  vin?: number;
  vf?: number;
  if?: number;
  series?: number;
  parallel?: number;
}

type FieldKey = keyof Fields;

/** Case-insensitive key synonyms accepted in key=value tokens. */
const KEY_MAP: Record<string, FieldKey> = {
  vin: "vin",
  vs: "vin",
  supply: "vin",
  vf: "vf",
  forward: "vf",
  if: "if",
  current: "if",
  iled: "if",
  series: "series",
  count: "series",
  n: "series",
  parallel: "parallel",
  strings: "parallel",
  p: "parallel",
};

interface ColorPreset {
  label: string;
  vf: number;
  /** Typical Vf range shown to the reader, e.g. "1.8-2.2 V". Omitted for fixed-Vf colors. */
  range?: string;
}

/** LED color presets: midpoint forward voltage for a range, or a fixed value. */
const COLOR_PRESETS: Record<string, ColorPreset> = {
  red: { label: "Red", vf: 2.0, range: "1.8-2.2 V" },
  green: { label: "Green", vf: 2.5, range: "2.0-3.0 V" },
  "blue-white": { label: "Blue / white", vf: 3.2, range: "3.0-3.4 V" },
  ir: { label: "Infrared", vf: 1.2 },
  uv: { label: "Ultraviolet", vf: 3.4 },
};

/** Standard resistor value series, one decade (1.00-9.76 style). */
const E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
const E24 = [
  1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6,
  6.2, 6.8, 7.5, 8.2, 9.1,
];
const E96 = [
  1.0, 1.02, 1.05, 1.07, 1.1, 1.13, 1.15, 1.18, 1.21, 1.24, 1.27, 1.3, 1.33, 1.37, 1.4, 1.43, 1.47,
  1.5, 1.54, 1.58, 1.62, 1.65, 1.69, 1.74, 1.78, 1.82, 1.87, 1.91, 1.96, 2.0, 2.05, 2.1, 2.15, 2.21,
  2.26, 2.32, 2.37, 2.43, 2.49, 2.55, 2.61, 2.67, 2.74, 2.8, 2.87, 2.94, 3.01, 3.09, 3.16, 3.24,
  3.32, 3.4, 3.48, 3.57, 3.65, 3.74, 3.83, 3.92, 4.02, 4.12, 4.22, 4.32, 4.42, 4.53, 4.64, 4.75,
  4.87, 4.99, 5.11, 5.23, 5.36, 5.49, 5.62, 5.76, 5.9, 6.04, 6.19, 6.34, 6.49, 6.65, 6.81, 6.98,
  7.15, 7.32, 7.5, 7.68, 7.87, 8.06, 8.25, 8.45, 8.66, 8.87, 9.09, 9.31, 9.53, 9.76,
];

/** Standard resistor power ratings, ascending. */
const WATTAGES = [0.125, 0.25, 0.5, 1, 2, 5];

/** Engineering-notation scale steps, exponent must be a multiple of 3. */
const SCALES = [
  { exp: -12, suf: "p" },
  { exp: -9, suf: "n" },
  { exp: -6, suf: "u" },
  { exp: -3, suf: "m" },
  { exp: 0, suf: "" },
  { exp: 3, suf: "k" },
  { exp: 6, suf: "M" },
  { exp: 9, suf: "G" },
  { exp: 12, suf: "T" },
];

/** Format a value in engineering notation with up to 3 significant figures, e.g. "4.70 kohm". */
function formatEng(value: number, unit: string): string {
  if (!Number.isFinite(value)) return `${value} ${unit}`;
  if (value === 0) return `0 ${unit}`;
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  let choice = SCALES[SCALES.length - 1];
  let found = false;
  for (const s of SCALES) {
    const scaled = abs / 10 ** s.exp;
    if (scaled >= 1 && scaled < 1000) {
      choice = s;
      found = true;
      break;
    }
  }
  if (!found && abs < 10 ** SCALES[0].exp) choice = SCALES[0];
  const scaled = abs / 10 ** choice.exp;
  const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  return `${sign}${scaled.toFixed(decimals)} ${choice.suf}${unit}`;
}

/** Bare unit-prefix letter to multiplier: p n u/µ m (none) k/K M G. */
function unitMultiplier(prefix: string | undefined): number {
  switch (prefix) {
    case "p":
      return 1e-12;
    case "n":
      return 1e-9;
    case "u":
    case "µ":
      return 1e-6;
    case "m":
      return 1e-3;
    case "k":
    case "K":
      return 1e3;
    case "M":
      return 1e6;
    case "G":
      return 1e9;
    default:
      return 1;
  }
}

/** Parse "4.7k", "100n", "20mA", "10", "5V" etc into a plain number, unit-prefix aware. */
function parseUnitNumber(raw: string, label: string): number {
  const s = raw.trim();
  const m = s.match(/^([+-]?\d*\.?\d+)\s*(p|n|u|µ|m|k|K|M|G)?[A-Za-zΩ%°]*$/);
  if (!m || m[1] === "" || m[1] === "+" || m[1] === "-") {
    throw new ToolError(
      "bad-token",
      `Could not parse ${label} "${raw}".`,
      "Use a plain number, optionally with a unit prefix like k, M, m, u, n, or p.",
    );
  }
  const num = Number(m[1]);
  if (!Number.isFinite(num)) {
    throw new ToolError("bad-token", `Could not parse ${label} "${raw}".`);
  }
  return num * unitMultiplier(m[2]);
}

/** Tokenize "vin=9 if=20mA series=3" style input into named fields. */
function parseInput(input: string): Fields {
  const raw = (input ?? "").trim();
  if (!raw) {
    throw new ToolError(
      "empty-input",
      'Enter values to calculate, like "vin=9 if=20mA".',
      'Try "vin=9 if=20mA" or "vin=12 vf=3.2 series=3" depending on the LED color.',
    );
  }

  const tokens = raw.split(/[\s,]+/).filter(Boolean);
  const fields: Fields = {};

  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq <= 0) {
      throw new ToolError(
        "bad-token",
        `Could not parse "${token}"; expected a key=value token.`,
        'Use tokens like "vin=9", "if=20mA", "series=3", or "parallel=2".',
      );
    }

    const keyRaw = token.slice(0, eq).toLowerCase();
    const valRaw = token.slice(eq + 1);
    const field = KEY_MAP[keyRaw];
    if (!field) {
      throw new ToolError(
        "bad-token",
        `Unrecognized key "${keyRaw}" in "${token}".`,
        "Use vin, vf, if, series, or parallel (with their aliases vs/supply, forward, current/iled, count/n, strings/p).",
      );
    }

    fields[field] = parseUnitNumber(valRaw, token);
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

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new ToolError(
      "impossible",
      `${name} must be a whole number of 1 or more, got ${value}.`,
      `Provide a positive whole number for ${name}.`,
    );
  }
}

/** Nearest standard series value at or above `exact`, searched across nearby decades. */
function nearestAtOrAbove(exact: number, series: number[]): number {
  if (exact <= 0) return series[0];
  const decade = Math.floor(Math.log10(exact));
  let best: number | null = null;
  for (const exp of [decade - 1, decade, decade + 1, decade + 2]) {
    for (const base of series) {
      const candidate = Math.round(base * 10 ** exp * 1e6) / 1e6;
      if (candidate >= exact - 1e-9 && (best === null || candidate < best)) best = candidate;
    }
  }
  return best ?? exact;
}

/** Nearest standard series value at or below `exact`, searched across nearby decades. */
function nearestAtOrBelow(exact: number, series: number[]): number {
  if (exact <= 0) return series[0];
  const decade = Math.floor(Math.log10(exact));
  let best: number | null = null;
  for (const exp of [decade - 1, decade, decade + 1, decade + 2]) {
    for (const base of series) {
      const candidate = Math.round(base * 10 ** exp * 1e6) / 1e6;
      if (candidate <= exact + 1e-9 && (best === null || candidate > best)) best = candidate;
    }
  }
  return best ?? exact;
}

function recommendedWattage(actualPowerW: number): string {
  const needed = actualPowerW * 2;
  const found = WATTAGES.find((w) => w >= needed);
  return found !== undefined
    ? `${found} W`
    : "5 W (exceeds standard ratings, use a power resistor)";
}

// ---------------------------------------------------------------------------

export function run(input: string, opts: LedResistorOpts): LedResistorResult {
  const fields = parseInput(input);
  const colorKey = opts.color || "custom";

  let vfPerLed: number;
  let vfDescription: string;

  if (colorKey === "custom") {
    if (fields.vf === undefined) {
      throw new ToolError(
        "missing-values",
        'Custom color needs vf (for example "vf=2.1").',
        "Add a vf= token with the LED's forward voltage, or pick a color preset instead.",
      );
    }
    vfPerLed = fields.vf;
    assertPositive("vf", vfPerLed);
    vfDescription = `${formatEng(vfPerLed, "V")} (custom)`;
  } else {
    const preset = COLOR_PRESETS[colorKey];
    if (!preset) {
      throw new ToolError(
        "bad-option",
        `Unrecognized LED color "${colorKey}".`,
        "Choose red, green, blue-white, ir, uv, or custom.",
      );
    }
    vfPerLed = preset.vf;
    assertPositive("vf", vfPerLed);
    vfDescription = preset.range
      ? `${formatEng(vfPerLed, "V")} (${preset.label.toLowerCase()} preset, typical range ${preset.range})`
      : `${formatEng(vfPerLed, "V")} (${preset.label.toLowerCase()} preset, fixed at ${formatEng(vfPerLed, "V")})`;
  }

  if (fields.vin === undefined) {
    throw new ToolError(
      "missing-values",
      'Enter vin, the supply voltage (for example "vin=9").',
      "Add a vin= token with the supply voltage.",
    );
  }
  const vin = fields.vin;
  assertPositive("vin", vin);

  let ifVal = fields.if;
  let ifAssumed = false;
  if (ifVal === undefined) {
    ifVal = 0.02;
    ifAssumed = true;
  } else {
    assertPositive("if", ifVal);
  }

  let seriesCount = 1;
  if (fields.series !== undefined) {
    assertPositiveInteger("series", fields.series);
    seriesCount = fields.series;
  }

  let parallelCount = 1;
  if (fields.parallel !== undefined) {
    assertPositiveInteger("parallel", fields.parallel);
    parallelCount = fields.parallel;
  }

  const vfTotal = vfPerLed * seriesCount;
  if (vin <= vfTotal) {
    throw new ToolError(
      "impossible",
      `Supply voltage (${formatEng(vin, "V")}) does not exceed the total LED forward voltage (${formatEng(vfTotal, "V")}), so no resistor value can limit current in this configuration.`,
      "Increase the supply voltage, use fewer LEDs in series, or choose a lower-Vf color.",
    );
  }

  const vDrop = vin - vfTotal;
  const exactR = vDrop / ifVal;

  const candidateLine = (r: number): string => {
    const actualCurrent = vDrop / r;
    const power = vDrop * actualCurrent;
    return `${formatEng(r, "ohm")} -> ${formatEng(actualCurrent, "A")}, ${formatEng(power, "W")}, recommended rating ${recommendedWattage(power)}`;
  };

  const result: LedResistorResult = {};
  result["LED forward voltage"] = vfDescription;
  result["Total forward voltage (series)"] =
    seriesCount > 1
      ? `${formatEng(vfTotal, "V")} (${formatEng(vfPerLed, "V")} x ${seriesCount} LEDs in series)`
      : formatEng(vfTotal, "V");
  result["Forward current"] = ifAssumed
    ? `${formatEng(ifVal, "A")} (assumed 20 mA, none given)`
    : formatEng(ifVal, "A");
  result["Voltage across resistor"] = formatEng(vDrop, "V");
  result["Exact resistor value"] = formatEng(exactR, "ohm");
  result["E12 at or above"] = candidateLine(nearestAtOrAbove(exactR, E12));
  result["E12 at or below"] = candidateLine(nearestAtOrBelow(exactR, E12));
  result["E24 at or above"] = candidateLine(nearestAtOrAbove(exactR, E24));
  result["E24 at or below"] = candidateLine(nearestAtOrBelow(exactR, E24));
  result["E96 at or above"] = candidateLine(nearestAtOrAbove(exactR, E96));
  result["E96 at or below"] = candidateLine(nearestAtOrBelow(exactR, E96));

  const totalPower = vin * ifVal * parallelCount;
  result["Total power (all strings)"] =
    parallelCount > 1
      ? `${formatEng(totalPower, "W")} (supply-side estimate at ${formatEng(ifVal, "A")} per string x ${parallelCount} strings)`
      : `${formatEng(totalPower, "W")} (supply-side estimate)`;

  const exactPower = vDrop * ifVal;
  if (exactPower > 0.25) {
    result["Warning"] =
      `Exact resistor dissipates over 0.25 W (${formatEng(exactPower, "W")}). Use a resistor rated at least ${recommendedWattage(exactPower)}; a standard 0.25 W part will overheat.`;
  }

  if (ifAssumed) {
    result["Note"] =
      "No LED current given, so If was assumed to be 20 mA, a common indicator LED default.";
  }

  result["Formula"] = "R = (Vin - Vf x series) / If";

  return result;
}

export default { run } satisfies ToolLogic<string, LedResistorResult, LedResistorOpts>;

// Exported for tests only; not part of the tool's public logic surface.
export const __test__ = { formatEng, nearestAtOrAbove, nearestAtOrBelow, COLOR_PRESETS };
