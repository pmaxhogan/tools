import { ToolError, type ToolLogic } from "../types";

export interface CapacitorOpts {
  /** "decode" | "encode" */
  mode: string;
  /** encode only: a tolerance letter such as "K" */
  tolerance?: string;
  [key: string]: unknown;
}

export type CapacitorResult = Record<string, string>;

// ---------------------------------------------------------------------------
// Shared unit-parsing / formatting helpers
// ---------------------------------------------------------------------------

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

/** Parse "4.7k", "100n", "220p", "10", etc into a plain number, unit-prefix aware. */
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

/** Fixed-decimal formatting with trailing zeros trimmed, e.g. 100000 -> "100000", 2.2 -> "2.2". */
function formatPlain(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  let s = n.toFixed(6);
  if (s.includes(".")) {
    s = s.replace(/0+$/, "");
    s = s.replace(/\.$/, "");
  }
  return s;
}

/** The nicest larger unit for a pF value, or null when pF is already the natural scale. */
function niceUnitSuffix(pF: number): string | null {
  const abs = Math.abs(pF);
  if (abs >= 1e6) return `${formatPlain(pF / 1e6)} uF`;
  if (abs >= 1e3) return `${formatPlain(pF / 1e3)} nF`;
  return null;
}

// ---------------------------------------------------------------------------
// Lookup tables (EIA-198 and common real-world markings)
// ---------------------------------------------------------------------------

/** EIA standard tolerance letter codes. */
const TOLERANCE_TABLE: Record<string, string> = {
  B: "+/-0.1 pF",
  C: "+/-0.25 pF",
  D: "+/-0.5 pF",
  F: "+/-1%",
  G: "+/-2%",
  J: "+/-5%",
  K: "+/-10%",
  M: "+/-20%",
  P: "+100%/-0%",
  Z: "+80%/-20%",
};

/** Common EIA-198-style voltage codes: digit+letter -> volts. Not perfectly standardized industry-wide. */
const VOLTAGE_TABLE: Record<string, number> = {
  "0J": 6.3,
  "1A": 10,
  "1C": 16,
  "1D": 20,
  "1E": 25,
  "1V": 35,
  "1H": 50,
  "1J": 63,
  "2A": 100,
  "2D": 200,
  "2E": 250,
  "2G": 400,
};

/** Temperature coefficient class codes and what they mean in practice. */
const TEMPCO_TABLE: Record<string, string> = {
  NP0: "Ultra-stable, ~0 ppm/degC, no aging, best for RF and precision timing circuits.",
  C0G: "Ultra-stable, ~0 ppm/degC, no aging, best for RF and precision timing circuits.",
  X7R: "+/-15% over -55C to +125C, general purpose, some voltage and aging sensitivity.",
  X5R: "+/-15% over -55C to +85C, smaller size than X7R at the same value, more voltage sensitivity.",
  Y5V: "+22%/-82% over -30C to +85C, high capacitance density but poor stability, avoid for anything precision or timing related.",
  Z5U: "+22%/-56% over +10C to +85C, similar poor stability to Y5V, common in inexpensive decoupling caps.",
};

// ---------------------------------------------------------------------------
// Reactance
// ---------------------------------------------------------------------------

const REACTANCE_FREQS: [number, string][] = [
  [50, "50 Hz"],
  [60, "60 Hz"],
  [1000, "1 kHz"],
  [1_000_000, "1 MHz"],
];

function reactanceRows(farads: number): CapacitorResult {
  const rows: CapacitorResult = {};
  for (const [f, label] of REACTANCE_FREQS) {
    const xc = farads > 0 ? 1 / (2 * Math.PI * f * farads) : Infinity;
    rows[`Reactance at ${label}`] = formatEng(xc, "ohm");
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Decode: code -> value
// ---------------------------------------------------------------------------

/** A token that may be the primary numeric code, with an optional fused tolerance letter and voltage. */
const FUSED_CODE_RE = /^(\d+[Rr]\d+|\d+)([A-Za-z])?(?:(\d+(?:\.\d+)?)([Vv]))?$/;

function decodeCodeValue(code: string): { pF: number; breakdown: string } {
  const rMatch = code.match(/^(\d+)[Rr](\d+)$/);
  if (rMatch) {
    const pF = Number(`${rMatch[1]}.${rMatch[2]}`);
    return { pF, breakdown: `${formatPlain(pF)} pF (R notation: R replaces the decimal point)` };
  }

  if (!/^\d+$/.test(code)) {
    throw new ToolError(
      "bad-code",
      `"${code}" is not a recognized capacitor code.`,
      'Use a 3-digit code like "104", a 2-digit direct pF value like "22", or R notation like "4R7".',
    );
  }

  if (code.length === 3) {
    const d1 = Number(code[0]);
    const d2 = Number(code[1]);
    const d3 = Number(code[2]);
    const sig = d1 * 10 + d2;
    const isException = d3 === 9;
    const mult = isException ? 0.1 : 10 ** d3;
    const pF = sig * mult;
    const multLabel = isException ? "0.1" : `10^${d3}`;
    let breakdown = `${sig} x ${multLabel} pF = ${formatPlain(pF)} pF`;
    const nice = niceUnitSuffix(pF);
    if (nice) breakdown += ` = ${nice}`;
    return { pF, breakdown };
  }

  if (code.length === 2) {
    const pF = Number(code);
    return { pF, breakdown: `${formatPlain(pF)} pF (direct 2-digit marking, no multiplier digit)` };
  }

  if (code.length === 1) {
    const pF = Number(code);
    return { pF, breakdown: `${formatPlain(pF)} pF (direct 1-digit marking)` };
  }

  throw new ToolError(
    "bad-code",
    `"${code}" is not a recognized capacitor code shape.`,
    'Use a 3-digit code like "104", a 2-digit value like "22", a 1-digit value, or R notation like "4R7".',
  );
}

function decode(raw: string): CapacitorResult {
  const tokens = raw.split(/[\s,]+/).filter(Boolean);

  let primaryCode: string | undefined;
  let tolLetter: string | undefined;
  let voltageVolts: number | undefined;
  let voltageCodeUsed: string | undefined;
  let tempcoKey: string | undefined;

  for (const token of tokens) {
    const upper = token.toUpperCase();

    if (TEMPCO_TABLE[upper]) {
      tempcoKey = upper;
      continue;
    }

    const voltMatch = token.match(/^(\d+(?:\.\d+)?)[Vv]$/);
    if (voltMatch) {
      voltageVolts = Number(voltMatch[1]);
      voltageCodeUsed = undefined;
      continue;
    }

    if (/^\d[A-Za-z]$/.test(token)) {
      const key = token[0] + token[1].toUpperCase();
      if (VOLTAGE_TABLE[key] !== undefined) {
        voltageVolts = VOLTAGE_TABLE[key];
        voltageCodeUsed = key;
        continue;
      }
      // Not a known voltage code; fall through to the fused-code check below,
      // which will read it as a digit code plus a tolerance letter instead.
    }

    if (/^[A-Za-z]$/.test(token)) {
      const letter = upper;
      if (TOLERANCE_TABLE[letter]) {
        tolLetter = letter;
        continue;
      }
      throw new ToolError(
        "bad-code",
        `Unrecognized tolerance letter "${token}".`,
        "Use one of B, C, D, F, G, J, K, M, P, or Z.",
      );
    }

    const fused = token.match(FUSED_CODE_RE);
    if (fused && primaryCode === undefined) {
      primaryCode = fused[1];
      if (fused[2]) {
        const letter = fused[2].toUpperCase();
        if (!TOLERANCE_TABLE[letter]) {
          throw new ToolError(
            "bad-code",
            `Unrecognized tolerance letter "${fused[2]}".`,
            "Use one of B, C, D, F, G, J, K, M, P, or Z.",
          );
        }
        tolLetter = letter;
      }
      if (fused[3]) {
        voltageVolts = Number(fused[3]);
        voltageCodeUsed = undefined;
      }
      continue;
    }

    if (/^\d/.test(token) && primaryCode === undefined) {
      throw new ToolError(
        "bad-code",
        `"${token}" is not a recognized capacitor code.`,
        'Use a 3-digit code like "104", a 2-digit direct pF value like "22", or R notation like "4R7".',
      );
    }
    // Otherwise: an extra token that does not match any known field. Ignore
    // it rather than fail the whole run; the primary code is what matters.
  }

  if (primaryCode === undefined) {
    throw new ToolError(
      "bad-code",
      "No recognizable capacitor code found in the input.",
      'Enter a code like "104", "104K", "22", or "4R7".',
    );
  }

  const { pF, breakdown } = decodeCodeValue(primaryCode);
  const farads = pF * 1e-12;

  const result: CapacitorResult = {
    "Value in pF": `${formatPlain(pF)} pF`,
    "Value in nF": `${formatPlain(pF / 1e3)} nF`,
    "Value in uF": `${formatPlain(pF / 1e6)} uF`,
    "EIA-198 breakdown": breakdown,
  };

  if (tolLetter) {
    result["Tolerance"] = `${TOLERANCE_TABLE[tolLetter]} (${tolLetter})`;
  }
  if (voltageVolts !== undefined) {
    result["Voltage rating"] = voltageCodeUsed
      ? `${formatPlain(voltageVolts)} V (code ${voltageCodeUsed})`
      : `${formatPlain(voltageVolts)} V`;
  }
  if (tempcoKey) {
    result["Temperature coefficient"] = `${tempcoKey}: ${TEMPCO_TABLE[tempcoKey]}`;
  }

  Object.assign(result, reactanceRows(farads));
  return result;
}

// ---------------------------------------------------------------------------
// Encode: value -> code
// ---------------------------------------------------------------------------

function encode(raw: string, opts: CapacitorOpts): CapacitorResult {
  const farads = parseUnitNumber(raw, "capacitance value");
  if (!Number.isFinite(farads) || farads <= 0) {
    throw new ToolError(
      "bad-value",
      `"${raw}" is not a valid capacitance; it must be a positive number.`,
      'Use a value like "100nF", "0.1uF", "220pF", or "4.7uF".',
    );
  }

  const toleranceLetter = String(opts.tolerance ?? "K").toUpperCase();
  if (!TOLERANCE_TABLE[toleranceLetter]) {
    throw new ToolError(
      "bad-option",
      `Unrecognized tolerance "${opts.tolerance}".`,
      "Choose one of B, C, D, F, G, J, K, M, P, or Z.",
    );
  }

  const pF = farads * 1e12;
  let exp = Math.floor(Math.log10(pF)) - 1;
  let mantissa = Math.round(pF / 10 ** exp);
  if (mantissa >= 100) {
    mantissa = Math.round(mantissa / 10);
    exp += 1;
  }
  if (mantissa < 10) {
    mantissa *= 10;
    exp -= 1;
  }

  if (exp > 8) {
    throw new ToolError(
      "bad-value",
      `"${raw}" is too large to represent as a standard 3-digit EIA-198 code.`,
      "Very large capacitance values (electrolytics, tantalums) are usually printed in plain microfarads on the case instead of a 3-digit code.",
    );
  }
  if (exp < -1) {
    throw new ToolError(
      "bad-value",
      `"${raw}" (${formatPlain(pF)} pF) is too small to represent as a 3-digit EIA-198 code.`,
      'The smallest representable value is about 1 pF. For values under that, capacitors are usually marked in plain pF, like "0.5pF" printed directly.',
    );
  }

  const thirdDigit = exp === -1 ? 9 : exp;
  const code = `${mantissa}${thirdDigit}`;
  const encodedPF = mantissa * (thirdDigit === 9 ? 0.1 : 10 ** exp);
  const encodedFarads = encodedPF * 1e-12;
  const errPct = farads === 0 ? 0 : (Math.abs(encodedFarads - farads) / farads) * 100;

  const result: CapacitorResult = {
    "Input value": formatEng(farads, "F"),
    "Nearest EIA-198 code": code,
    "Encoded value": formatEng(encodedFarads, "F"),
    Error: `${errPct.toFixed(2)}%`,
    "Full marking": `${code}${toleranceLetter}`,
    Tolerance: `${TOLERANCE_TABLE[toleranceLetter]} (${toleranceLetter})`,
  };

  Object.assign(result, reactanceRows(encodedFarads));
  return result;
}

// ---------------------------------------------------------------------------

export function run(input: string, opts: CapacitorOpts): CapacitorResult {
  const raw = (input ?? "").trim();
  const mode = (opts.mode || "decode").toLowerCase();
  if (mode !== "decode" && mode !== "encode") {
    throw new ToolError(
      "bad-option",
      `Unrecognized mode "${opts.mode}".`,
      'Use "decode" or "encode".',
    );
  }
  if (!raw) {
    throw new ToolError(
      "empty-input",
      mode === "decode"
        ? 'Enter a capacitor code, like "104" or "104K".'
        : 'Enter a capacitance value, like "100nF" or "4.7uF".',
      mode === "decode"
        ? 'Try "104J" for a 100 nF, 5% ceramic capacitor.'
        : 'Try "100nF", "0.1uF", or "220pF".',
    );
  }

  return mode === "decode" ? decode(raw) : encode(raw, opts);
}

export default { run } satisfies ToolLogic<string, CapacitorResult, CapacitorOpts>;

// Exported for tests only; not part of the tool's public logic surface.
export const __test__ = { formatEng, formatPlain, parseUnitNumber, decodeCodeValue };
