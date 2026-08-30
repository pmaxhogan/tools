import { ToolError, type ToolLogic } from "../types";

export interface VoltageDividerOpts {
  [key: string]: unknown;
}

export type VoltageDividerResult = Record<string, string>;

type Field = "vin" | "r1" | "r2" | "vout" | "rtotal" | "load";

/** Case-insensitive key synonyms accepted in key=value tokens. */
const KEY_MAP: Record<string, Field> = {
  vin: "vin",
  vs: "vin",
  supply: "vin",
  r1: "r1",
  r2: "r2",
  vout: "vout",
  target: "vout",
  rtotal: "rtotal",
  total: "rtotal",
  budget: "rtotal",
  load: "load",
  rl: "load",
};

/** Standard resistor value series, one decade (1.0 - 9.1). */
const E24 = [
  1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6,
  6.2, 6.8, 7.5, 8.2, 9.1,
];

/** Common supply voltages the ratio table is computed against. */
const COMMON_SUPPLIES = [3.3, 5, 9, 12, 24];

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

interface ParsedInput {
  fields: Partial<Record<Field, number>>;
}

/** Tokenize "vin=12 r1=1k r2=2k" style input into named fields. */
function parseInput(input: string): ParsedInput {
  const raw = (input ?? "").trim();
  if (!raw) {
    throw new ToolError(
      "empty-input",
      'Enter values to calculate, like "vin=12 r1=1k r2=2k".',
      'Try "vin=12 r1=1k r2=2k", "vin=12 vout=5 r1=10k", "vin=12 vout=5 rtotal=10k", or "vin=12 vout=5".',
    );
  }

  const tokens = raw.split(/[\s,]+/).filter(Boolean);
  const fields: Partial<Record<Field, number>> = {};

  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq <= 0) {
      throw new ToolError(
        "bad-token",
        `Could not parse "${token}".`,
        "Use key=value tokens, like vin=12 or r1=1k.",
      );
    }
    const keyRaw = token.slice(0, eq).toLowerCase();
    const valRaw = token.slice(eq + 1);
    const field = KEY_MAP[keyRaw];
    if (!field) {
      throw new ToolError(
        "bad-token",
        `Unrecognized key "${keyRaw}" in "${token}".`,
        "Use keys like vin, r1, r2, vout, rtotal, or load.",
      );
    }
    fields[field] = parseUnitNumber(valRaw, keyRaw);
  }

  return { fields };
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

function candidatesAroundDecades(exps: number[]): number[] {
  const vals: number[] = [];
  for (const exp of exps)
    for (const base of E24) vals.push(Math.round(base * 10 ** exp * 1e6) / 1e6);
  return vals;
}

/** Nearest E24 candidate to `exact`, searched one decade below and above. */
function nearestE24(exact: number): number {
  if (exact <= 0) return E24[0];
  const decade = Math.floor(Math.log10(exact));
  const candidates = candidatesAroundDecades([decade - 1, decade, decade + 1]);
  let best = candidates[0];
  let bestDiff = Infinity;
  for (const cand of candidates) {
    const diff = Math.abs(cand - exact);
    if (diff < bestDiff) {
      best = cand;
      bestDiff = diff;
    }
  }
  return best;
}

/** Ratio table rows for a fixed set of common supply voltages, given this divider's r2/(r1+r2) ratio. */
function ratioTableRows(ratio: number, actualVin: number): VoltageDividerResult {
  const rows: VoltageDividerResult = {};
  for (const supply of COMMON_SUPPLIES) {
    const voutAtSupply = supply * ratio;
    const isActual = Math.abs(supply - actualVin) < 1e-9;
    rows[`At ${supply} V supply`] = isActual
      ? `${formatEng(voutAtSupply, "V")} (this circuit's supply)`
      : formatEng(voutAtSupply, "V");
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Case 1: r1 and r2 both given -> forward compute, optionally under load.
// ---------------------------------------------------------------------------

function runForwardCompute(
  vin: number,
  r1: number,
  r2: number,
  load: number | undefined,
): VoltageDividerResult {
  assertPositive("r1", r1);
  assertPositive("r2", r2);

  const current = vin / (r1 + r2);
  const voutActual = (vin * r2) / (r1 + r2);
  const p1 = current * current * r1;
  const p2 = current * current * r2;

  const result: VoltageDividerResult = {
    Vout: formatEng(voutActual, "V"),
    Current: formatEng(current, "A"),
    "R1 power": formatEng(p1, "W"),
    "R2 power": formatEng(p2, "W"),
    Formula: "Vout = Vin x R2 / (R1 + R2)",
  };

  if (load !== undefined) {
    assertPositive("load", load);
    const reff = (r2 * load) / (r2 + load);
    const voutLoaded = (vin * reff) / (r1 + reff);
    const sagV = voutActual - voutLoaded;
    const sagPct = voutActual === 0 ? 0 : (sagV / voutActual) * 100;
    const currentLoaded = vin / (r1 + reff);
    const p2Loaded = currentLoaded * currentLoaded * reff;

    result["Vout (loaded)"] = formatEng(voutLoaded, "V");
    result["Sag"] = formatEng(sagV, "V");
    result["Sag percent"] = `${sagPct.toFixed(2)}%`;
    result["R2 power (loaded)"] = formatEng(p2Loaded, "W");
  }

  Object.assign(result, ratioTableRows(r2 / (r1 + r2), vin));
  return result;
}

// ---------------------------------------------------------------------------
// Case 2: exactly one resistor given, plus vout -> solve the missing one.
// ---------------------------------------------------------------------------

function runSolveOneResistor(
  vin: number,
  r1: number | undefined,
  r2: number | undefined,
  vout: number,
): VoltageDividerResult {
  assertPositive("vout", vout);
  if (vout <= 0 || vout >= vin) {
    throw new ToolError(
      "impossible",
      `vout (${formatEng(vout, "V")}) must be between 0 and vin (${formatEng(vin, "V")}) for a resistive divider.`,
      "Choose a target vout below vin and above zero.",
    );
  }

  if (r1 !== undefined) {
    assertPositive("r1", r1);
    const exactR2 = (r1 * vout) / (vin - vout);
    const nearest = nearestE24(exactR2);
    const voutActual = (vin * nearest) / (r1 + nearest);
    const err = Math.abs(voutActual - vout) / vout;
    const result: VoltageDividerResult = {
      "R1 (given)": formatEng(r1, "ohm"),
      "Exact R2": formatEng(exactR2, "ohm"),
      "Nearest E24 R2": formatEng(nearest, "ohm"),
      "Achieved Vout": formatEng(voutActual, "V"),
      Error: `${(err * 100).toFixed(2)}%`,
      Formula: "R2 = R1 x Vout / (Vin - Vout)",
    };
    Object.assign(result, ratioTableRows(nearest / (r1 + nearest), vin));
    return result;
  }

  const r2v = r2 as number;
  assertPositive("r2", r2v);
  const exactR1 = (r2v * (vin - vout)) / vout;
  const nearest = nearestE24(exactR1);
  const voutActual = (vin * r2v) / (nearest + r2v);
  const err = Math.abs(voutActual - vout) / vout;
  const result: VoltageDividerResult = {
    "R2 (given)": formatEng(r2v, "ohm"),
    "Exact R1": formatEng(exactR1, "ohm"),
    "Nearest E24 R1": formatEng(nearest, "ohm"),
    "Achieved Vout": formatEng(voutActual, "V"),
    Error: `${(err * 100).toFixed(2)}%`,
    Formula: "R1 = R2 x (Vin - Vout) / Vout",
  };
  Object.assign(result, ratioTableRows(r2v / (nearest + r2v), vin));
  return result;
}

// ---------------------------------------------------------------------------
// Case 3: neither resistor given, vout + rtotal -> solve both from a budget.
// ---------------------------------------------------------------------------

function runSolveFromBudget(vin: number, vout: number, rtotal: number): VoltageDividerResult {
  assertPositive("vout", vout);
  assertPositive("rtotal", rtotal);
  if (vout <= 0 || vout >= vin) {
    throw new ToolError(
      "impossible",
      `vout (${formatEng(vout, "V")}) must be between 0 and vin (${formatEng(vin, "V")}) for a resistive divider.`,
      "Choose a target vout below vin and above zero.",
    );
  }

  const exactR2 = (rtotal * vout) / vin;
  const exactR1 = rtotal - exactR2;
  const nearestR1 = nearestE24(exactR1);
  const nearestR2 = nearestE24(exactR2);
  const voutActual = (vin * nearestR2) / (nearestR1 + nearestR2);
  const err = Math.abs(voutActual - vout) / vout;

  const result: VoltageDividerResult = {
    "Total resistance (given)": formatEng(rtotal, "ohm"),
    "Exact R1": formatEng(exactR1, "ohm"),
    "Exact R2": formatEng(exactR2, "ohm"),
    "Nearest E24 R1": formatEng(nearestR1, "ohm"),
    "Nearest E24 R2": formatEng(nearestR2, "ohm"),
    "Achieved Vout": formatEng(voutActual, "V"),
    Error: `${(err * 100).toFixed(2)}%`,
    Formula: "R2 = Rtotal x Vout / Vin; R1 = Rtotal - R2",
  };
  Object.assign(result, ratioTableRows(nearestR2 / (nearestR1 + nearestR2), vin));
  return result;
}

// ---------------------------------------------------------------------------
// Case 4: only vin and vout given -> suggest three E24 pairs around 10k.
// ---------------------------------------------------------------------------

function runSuggestPairs(vin: number, vout: number): VoltageDividerResult {
  assertPositive("vout", vout);
  if (vout <= 0 || vout >= vin) {
    throw new ToolError(
      "impossible",
      `vout (${formatEng(vout, "V")}) must be between 0 and vin (${formatEng(vin, "V")}) for a resistive divider.`,
      "Choose a target vout below vin and above zero.",
    );
  }

  const candidates = candidatesAroundDecades([3, 4, 5]);
  const scored: { r1: number; r2: number; voutActual: number; err: number }[] = [];
  for (const cr1 of candidates) {
    for (const cr2 of candidates) {
      const voutActual = (vin * cr2) / (cr1 + cr2);
      const err = Math.abs(voutActual - vout) / vout;
      scored.push({ r1: cr1, r2: cr2, voutActual, err });
    }
  }
  scored.sort((a, b) => a.err - b.err);

  const top: typeof scored = [];
  for (const s of scored) {
    if (top.length >= 3) break;
    if (top.some((t) => t.r1 === s.r1 && t.r2 === s.r2)) continue;
    top.push(s);
  }

  const result: VoltageDividerResult = {};
  top.forEach((t, i) => {
    result[`Suggestion ${i + 1}`] =
      `R1 = ${formatEng(t.r1, "ohm")}, R2 = ${formatEng(t.r2, "ohm")} -> Vout = ${formatEng(t.voutActual, "V")} (error ${(t.err * 100).toFixed(2)}%)`;
  });
  result.Formula = "Vout = Vin x R2 / (R1 + R2)";

  const first = top[0];
  if (first) Object.assign(result, ratioTableRows(first.r2 / (first.r1 + first.r2), vin));
  return result;
}

// ---------------------------------------------------------------------------

export function run(input: string, _opts: VoltageDividerOpts): VoltageDividerResult {
  const { fields } = parseInput(input);

  if (fields.vin === undefined) {
    throw new ToolError(
      "missing-values",
      "voltage-divider needs vin, the supply voltage.",
      'Try "vin=12 r1=1k r2=2k", "vin=12 vout=5 r1=10k", "vin=12 vout=5 rtotal=10k", or "vin=12 vout=5".',
    );
  }
  const vin = fields.vin;
  assertPositive("vin", vin);

  const { r1, r2, vout, rtotal, load } = fields;

  // Case 1: both resistors given -> forward compute (regardless of vout/rtotal).
  if (r1 !== undefined && r2 !== undefined) {
    return runForwardCompute(vin, r1, r2, load);
  }

  // Case 2: exactly one resistor given, plus vout -> solve the missing one.
  if ((r1 !== undefined || r2 !== undefined) && vout !== undefined) {
    return runSolveOneResistor(vin, r1, r2, vout);
  }

  // Case 3: neither resistor given, but vout and rtotal given -> solve from a budget.
  if (r1 === undefined && r2 === undefined && vout !== undefined && rtotal !== undefined) {
    return runSolveFromBudget(vin, vout, rtotal);
  }

  // Case 4: only vin and vout given -> suggest three E24 pairs.
  if (r1 === undefined && r2 === undefined && vout !== undefined) {
    return runSuggestPairs(vin, vout);
  }

  // Case 5: only vin given, nothing else.
  throw new ToolError(
    "missing-values",
    "voltage-divider needs r1 and r2, or vout plus one resistor or a total resistance, or vout alone for suggestions.",
    'Try "vin=12 r1=1k r2=2k", "vin=12 vout=5 r1=10k", "vin=12 vout=5 rtotal=10k", or "vin=12 vout=5".',
  );
}

export default { run } satisfies ToolLogic<string, VoltageDividerResult, VoltageDividerOpts>;

// Exported for tests only; not part of the tool's public logic surface.
export const __test__ = { formatEng, nearestE24 };
