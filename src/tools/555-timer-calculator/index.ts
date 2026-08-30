import { ToolError, type ToolLogic } from "../types";

export interface FiveFiveTimerOpts {
  /** "astable" | "monostable" */
  mode: string;
  /** "bipolar" | "cmos" */
  chip: string;
  [key: string]: unknown;
}

export type FiveFiveTimerResult = Record<string, string>;

const LN3 = 1.0986122886681098; // ln(3)

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

/** Standard resistor value series, one decade (1.0 - 9.1). */
const E24 = [
  1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6,
  6.2, 6.8, 7.5, 8.2, 9.1,
];

/**
 * Nearest E24 standard series value to `exact`, searched across nearby decades.
 * `toPrecision` cleans up floating point noise in `base * 10 ** exp` without the
 * fixed-scale rounding trick used for resistor-only values, which loses all
 * precision on the tiny farad-scale candidates a capacitor search needs.
 */
function nearestStandard(exact: number, series: number[]): number {
  if (exact <= 0) return series[0];
  const decade = Math.floor(Math.log10(exact));
  let best: number | null = null;
  let bestDiff = Infinity;
  for (const exp of [decade - 1, decade, decade + 1, decade + 2]) {
    for (const base of series) {
      const candidate = Number((base * 10 ** exp).toPrecision(10));
      const diff = Math.abs(candidate - exact);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = candidate;
      }
    }
  }
  return best ?? exact;
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

const CHIP_NOTE: Record<string, string> = {
  bipolar:
    "A bipolar NE555 needs roughly 4.5 to 16 V supply, its output cannot swing fully to the rails, and it draws a few milliamps of quiescent current.",
  cmos: "A CMOS 555 (TLC555, ICM7555, etc.) runs from about 2 to 18 V, swings its output nearly rail to rail, and draws only microamps at idle, at some cost to maximum output drive current.",
};

const ASTABLE_SKETCH = `Vcc --- R1 --- pin7 (discharge)
               |
               +--- pin6 (threshold), pin2 (trigger)
               |
               R2
               |
               +--- C --- GND
pin3 = output, pin4 = reset tied to Vcc, pin8 = Vcc, pin1 = GND
pin5 (control voltage) -> 10 nF to GND, optional`;

const MONOSTABLE_SKETCH = `Vcc --- R --- pin7 (discharge), pin6 (threshold)
              |
              C --- GND
pin2 = trigger (falling edge starts the pulse), pin3 = output, pin4 = reset tied to Vcc`;

interface Tokens {
  [key: string]: number;
}

const KEY_MAP: Record<string, string> = {
  r1: "r1",
  r2: "r2",
  c: "c",
  r: "r",
  freq: "freq",
  f: "freq",
  frequency: "freq",
  hz: "freq",
  duty: "duty",
  dc: "duty",
  dutycycle: "duty",
  w: "w",
  width: "w",
  pulse: "w",
  t: "w",
};

/** Tokenize "r1=10k r2=4.7k c=10n" style input into named fields. */
function parseInput(input: string): Tokens {
  const raw = (input ?? "").trim();
  if (!raw) {
    throw new ToolError(
      "empty-input",
      'Enter values to calculate, like "r1=10k r2=4.7k c=10n".',
      'Try "r1=10k r2=4.7k c=10n" for astable, or "r=100k w=10m" for monostable.',
    );
  }

  const tokens = raw.split(/[\s,]+/).filter(Boolean);
  const fields: Tokens = {};

  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq <= 0) {
      throw new ToolError(
        "bad-token",
        `Could not parse "${token}". Expected a key=value token.`,
        "Use tokens like r1=10k, r2=4.7k, c=10n, freq=1k, duty=60, r=100k, or w=10m.",
      );
    }
    const keyRaw = token.slice(0, eq).toLowerCase();
    const valRaw = token.slice(eq + 1);
    const key = KEY_MAP[keyRaw];
    if (!key) {
      throw new ToolError(
        "bad-token",
        `Unrecognized key "${keyRaw}" in "${token}".`,
        "Use keys like r1, r2, c, freq, duty (astable) or r, c, w (monostable).",
      );
    }
    fields[key] = parseUnitNumber(valRaw, `"${token}"`);
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Mode: astable
// ---------------------------------------------------------------------------

function astableForward(
  r1: number,
  r2: number,
  c: number,
): { thigh: number; tlow: number; t: number; freq: number; duty: number } {
  const thigh = 0.693 * (r1 + r2) * c;
  const tlow = 0.693 * r2 * c;
  const t = thigh + tlow;
  const freq = 1 / t;
  const duty = thigh / t;
  return { thigh, tlow, t, freq, duty };
}

function buildAstableResult(
  r1: number,
  r2: number,
  c: number,
  chip: string,
  extraRows: Record<string, string>,
): FiveFiveTimerResult {
  const { thigh, tlow, t, freq, duty } = astableForward(r1, r2, c);

  const result: FiveFiveTimerResult = {
    Frequency: formatEng(freq, "Hz"),
    Period: formatEng(t, "s"),
    "High time": formatEng(thigh, "s"),
    "Low time": formatEng(tlow, "s"),
    "Duty cycle": `${(duty * 100).toFixed(2)}%`,
    ...extraRows,
    "Chip note": CHIP_NOTE[chip],
    Sketch: ASTABLE_SKETCH,
  };
  if (r2 < 1000) {
    result.Note =
      "R2 below about 1 kohm risks exceeding the 555 discharge pin's rated current; most designs keep both timing resistors at 1 kohm or higher.";
  }
  result.Formula = "Thigh = 0.693 x (R1+R2) x C; Tlow = 0.693 x R2 x C";
  return result;
}

function runAstable(fields: Tokens, chip: string): FiveFiveTimerResult {
  const hasComponents =
    fields.r1 !== undefined && fields.r2 !== undefined && fields.c !== undefined;
  const hasTarget = fields.freq !== undefined && fields.duty !== undefined;

  if (!hasComponents && !hasTarget) {
    throw new ToolError(
      "missing-values",
      "Astable mode needs either r1, r2, and c, or a target freq and duty.",
      'Try "r1=10k r2=4.7k c=10n" or "freq=1k duty=60".',
    );
  }

  if (hasComponents) {
    const r1 = fields.r1;
    const r2 = fields.r2;
    const c = fields.c;
    assertPositive("r1", r1);
    assertPositive("r2", r2);
    assertPositive("c", c);
    return buildAstableResult(r1, r2, c, chip, {
      R1: formatEng(r1, "ohm"),
      R2: formatEng(r2, "ohm"),
      C: formatEng(c, "F"),
    });
  }

  // Solve from target freq + duty.
  const freq = fields.freq;
  const dutyPercent = fields.duty;
  assertPositive("freq", freq);
  if (!Number.isFinite(dutyPercent)) {
    throw new ToolError(
      "impossible",
      `duty must be a positive number, got ${dutyPercent}.`,
      "Provide a duty cycle percentage above 50.",
    );
  }

  if (dutyPercent <= 50) {
    throw new ToolError(
      "impossible",
      "A standard 555 astable circuit (no diode across R1) cannot produce a duty cycle of 50 percent or less; the high time is always at least as long as the low time in this topology.",
      "Choose a duty cycle above 50 percent, or use a diode-modified astable circuit, which this calculator does not model.",
    );
  }
  if (dutyPercent >= 100) {
    throw new ToolError(
      "impossible",
      "Duty cycle must be less than 100 percent.",
      "Choose a value between 50 and 100.",
    );
  }

  let c = fields.c;
  let cWasDefaulted = false;
  if (c === undefined) {
    c = 1e-8; // 10 nF default
    cWasDefaulted = true;
  } else {
    assertPositive("c", c);
  }

  const k = 1 / (freq * 0.693 * c); // R1 + 2*R2
  const r2Exact = k * (1 - dutyPercent / 100);
  const r1Exact = k * ((2 * dutyPercent) / 100 - 1);

  if (r1Exact <= 0) {
    throw new ToolError(
      "impossible",
      "A standard 555 astable circuit (no diode across R1) cannot produce a duty cycle of 50 percent or less; the high time is always at least as long as the low time in this topology.",
      "Choose a duty cycle above 50 percent, or use a diode-modified astable circuit, which this calculator does not model.",
    );
  }

  const r1Snapped = nearestStandard(r1Exact, E24);
  const r2Snapped = nearestStandard(r2Exact, E24);
  const achieved = astableForward(r1Snapped, r2Snapped, c);

  const extraRows: Record<string, string> = {
    "Exact R1": formatEng(r1Exact, "ohm"),
    "Nearest E24 R1": formatEng(r1Snapped, "ohm"),
    "Exact R2": formatEng(r2Exact, "ohm"),
    "Nearest E24 R2": formatEng(r2Snapped, "ohm"),
    C: formatEng(c, "F"),
    "Achieved frequency": formatEng(achieved.freq, "Hz"),
    "Achieved duty cycle": `${(achieved.duty * 100).toFixed(2)}%`,
  };
  if (cWasDefaulted) {
    extraRows.Assumption = "No capacitor given, so C was assumed to be 10 nF.";
  }

  // Use the achieved E24-snapped values as the headline numbers.
  return buildAstableResult(r1Snapped, r2Snapped, c, chip, extraRows);
}

// ---------------------------------------------------------------------------
// Mode: monostable
// ---------------------------------------------------------------------------

function buildMonostableResult(
  r: number,
  c: number,
  chip: string,
  extraRows: Record<string, string>,
): FiveFiveTimerResult {
  const w = LN3 * r * c;
  const result: FiveFiveTimerResult = {
    "Pulse width": formatEng(w, "s"),
    ...extraRows,
    "Chip note": CHIP_NOTE[chip],
    Sketch: MONOSTABLE_SKETCH,
    Formula: "W = 1.0986 x R x C (ln(3) x R x C)",
  };
  return result;
}

function runMonostable(fields: Tokens, chip: string): FiveFiveTimerResult {
  const hasComponents = fields.r !== undefined && fields.c !== undefined;
  const hasTarget = fields.w !== undefined;

  if (!hasComponents && !hasTarget) {
    throw new ToolError(
      "missing-values",
      "Monostable mode needs either r and c, or a target pulse width w.",
      'Try "r=100k c=100n" or "w=10m".',
    );
  }

  if (hasComponents) {
    const r = fields.r;
    const c = fields.c;
    assertPositive("r", r);
    assertPositive("c", c);
    return buildMonostableResult(r, c, chip, {
      R: formatEng(r, "ohm"),
      C: formatEng(c, "F"),
    });
  }

  const w = fields.w;
  assertPositive("w", w);

  if (fields.r !== undefined) {
    const r = fields.r;
    assertPositive("r", r);
    const cExact = w / (LN3 * r);
    const cSnapped = nearestStandard(cExact, E24);
    const achievedW = LN3 * r * cSnapped;
    return buildMonostableResult(r, cSnapped, chip, {
      R: formatEng(r, "ohm"),
      "Exact C": formatEng(cExact, "F"),
      "Nearest E24 C": formatEng(cSnapped, "F"),
      "Achieved pulse width": formatEng(achievedW, "s"),
    });
  }

  if (fields.c !== undefined) {
    const c = fields.c;
    assertPositive("c", c);
    const rExact = w / (LN3 * c);
    const rSnapped = nearestStandard(rExact, E24);
    const achievedW = LN3 * rSnapped * c;
    return buildMonostableResult(rSnapped, c, chip, {
      "Exact R": formatEng(rExact, "ohm"),
      "Nearest E24 R": formatEng(rSnapped, "ohm"),
      C: formatEng(c, "F"),
      "Achieved pulse width": formatEng(achievedW, "s"),
    });
  }

  // Neither r nor c given: default C = 100 nF, solve R.
  const c = 1e-7;
  const rExact = w / (LN3 * c);
  const rSnapped = nearestStandard(rExact, E24);
  const achievedW = LN3 * rSnapped * c;
  return buildMonostableResult(rSnapped, c, chip, {
    "Exact R": formatEng(rExact, "ohm"),
    "Nearest E24 R": formatEng(rSnapped, "ohm"),
    C: formatEng(c, "F"),
    "Achieved pulse width": formatEng(achievedW, "s"),
    Assumption: "No capacitor given, so C was assumed to be 100 nF.",
  });
}

// ---------------------------------------------------------------------------

export function run(input: string, opts: FiveFiveTimerOpts): FiveFiveTimerResult {
  const fields = parseInput(input);
  const mode = opts.mode || "astable";
  const chip = opts.chip || "bipolar";

  if (mode !== "astable" && mode !== "monostable") {
    throw new ToolError(
      "bad-option",
      `Unrecognized mode "${mode}".`,
      'Use "astable" or "monostable".',
    );
  }
  if (chip !== "bipolar" && chip !== "cmos") {
    throw new ToolError("bad-option", `Unrecognized chip "${chip}".`, 'Use "bipolar" or "cmos".');
  }

  if (mode === "monostable") return runMonostable(fields, chip);
  return runAstable(fields, chip);
}

export default { run } satisfies ToolLogic<string, FiveFiveTimerResult, FiveFiveTimerOpts>;

// Exported for tests only; not part of the tool's public logic surface.
export const __test__ = { formatEng, nearestStandard };
