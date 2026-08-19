import { ToolError, type ToolLogic } from "../types";

export interface OhmsLawOpts {
  /** "ohms-law" | "led-resistor" | "voltage-divider" */
  mode: string;
  [key: string]: unknown;
}

export type OhmsLawResult = Record<string, string>;

type Quantity = "V" | "I" | "R" | "P";
type Field = Quantity | "vin" | "vf" | "if" | "r1" | "r2" | "vout";

/** Case-insensitive key synonyms accepted in key=value tokens. */
const KEY_MAP: Record<string, Field> = {
  v: "V",
  volt: "V",
  volts: "V",
  voltage: "V",
  i: "I",
  current: "I",
  a: "I",
  amp: "I",
  amps: "I",
  r: "R",
  res: "R",
  resistance: "R",
  ohm: "R",
  ohms: "R",
  p: "P",
  power: "P",
  w: "P",
  watt: "P",
  watts: "P",
  vin: "vin",
  vs: "vin",
  supply: "vin",
  vf: "vf",
  forward: "vf",
  if: "if",
  iled: "if",
  ledcurrent: "if",
  r1: "r1",
  r2: "r2",
  vout: "vout",
};

const QUANTITY_INFO: Record<Quantity, { label: string; unit: string }> = {
  V: { label: "voltage", unit: "V" },
  I: { label: "current", unit: "A" },
  R: { label: "resistance", unit: "ohm" },
  P: { label: "power", unit: "W" },
};

const FIELD_LABEL: Record<Field, string> = {
  V: "voltage",
  I: "current",
  R: "resistance",
  P: "power",
  vin: "vin",
  vf: "vf",
  if: "if",
  r1: "r1",
  r2: "r2",
  vout: "vout",
};

/** Standard resistor value series, one decade (1.0 - 9.1). */
const E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
const E24 = [
  1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6,
  6.2, 6.8, 7.5, 8.2, 9.1,
];

/** Standard resistor power ratings, ascending. */
const WATTAGES = [0.125, 0.25, 0.5, 1, 2, 5];

/** Engineering-notation scale steps, exponent must be a multiple of 3. */
const SCALES = [
  { exp: -6, suf: "u" },
  { exp: -3, suf: "m" },
  { exp: 0, suf: "" },
  { exp: 3, suf: "k" },
  { exp: 6, suf: "M" },
  { exp: 9, suf: "G" },
];

/** Format a value in engineering notation with 3 significant figures, e.g. "4.70 kohm". */
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

/** Parse a bare unit suffix (no leading number) into a multiplier and, if determinable, a quantity kind. */
function parseUnitSuffix(suffix: string): { mult: number; kind: Quantity | null } | null {
  const bare = suffix.match(/^([kKMmuU]|µ)$/);
  if (bare) {
    const p = bare[1];
    const mult = p === "k" || p === "K" ? 1e3 : p === "M" ? 1e6 : p === "m" ? 1e-3 : 1e-6;
    return { mult, kind: null };
  }
  const m = suffix.match(/^([kKMmuU]|µ)?(ohms?|v|a|w)$/i);
  if (!m) return null;
  const prefix = m[1];
  const unitLetter = m[2].toLowerCase();
  const kind: Quantity = unitLetter.startsWith("ohm") ? "R" : unitLetter === "v" ? "V" : unitLetter === "a" ? "I" : "P";
  let mult = 1;
  if (prefix === "k" || prefix === "K") mult = 1e3;
  else if (prefix === "M") mult = 1e6;
  else if (prefix === "m") mult = 1e-3;
  else if (prefix === "u" || prefix === "U" || prefix === "µ") mult = 1e-6;
  return { mult, kind };
}

/** Parse "12", "4.7k", "100mA", "2M" etc into a number plus, when the unit implies one, a quantity kind. */
function parseNumberUnit(raw: string, tokenForError: string): { value: number; kind: Quantity | null } {
  const m = raw.match(/^([+-]?\d*\.?\d+)\s*([a-zA-Zµ]*)$/);
  if (!m || m[1] === "" || m[1] === "+" || m[1] === "-") {
    throw new ToolError(
      "bad-token",
      `Could not parse "${tokenForError}" as a number.`,
      "Use a plain number, optionally followed by a unit like V, mA, k, or ohm.",
    );
  }
  const num = Number(m[1]);
  if (!Number.isFinite(num)) {
    throw new ToolError("bad-token", `Could not parse "${tokenForError}" as a number.`);
  }
  const suffix = m[2];
  if (suffix === "") return { value: num, kind: null };
  const parsed = parseUnitSuffix(suffix);
  if (!parsed) {
    throw new ToolError(
      "bad-token",
      `Unrecognized unit "${suffix}" in "${tokenForError}".`,
      "Use V, mV, kV, A, mA, uA, W, mW, kW, ohm, kohm, or Mohm.",
    );
  }
  return { value: num * parsed.mult, kind: parsed.kind };
}

interface ParsedInput {
  fields: Partial<Record<Field, number>>;
  count?: number;
}

/** Tokenize "12V 100mA" / "V=12 I=0.1" / "R=4.7k P=2W" style input into named fields. */
function parseInput(input: string): ParsedInput {
  const raw = (input ?? "").trim();
  if (!raw) {
    throw new ToolError(
      "empty-input",
      "Enter values to calculate, like \"12V 100mA\".",
      'Try "12V 100mA", "R=4.7k P=2W", or "vin=12 vf=2.1 if=20mA" depending on the mode.',
    );
  }

  const tokens = raw.split(/[\s,]+/).filter(Boolean);
  const fields: Partial<Record<Field, number>> = {};
  let count: number | undefined;
  let vfEmbeddedCount: number | undefined;

  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq > 0) {
      const keyRaw = token.slice(0, eq).toLowerCase();
      const valRaw = token.slice(eq + 1);

      if (keyRaw === "count") {
        const n = Number.parseInt(valRaw, 10);
        if (!Number.isFinite(n) || n < 1) {
          throw new ToolError(
            "bad-token",
            `"${token}" is not a valid LED count.`,
            "Use a whole number of 1 or more, like count=3.",
          );
        }
        count = n;
        continue;
      }

      const field = KEY_MAP[keyRaw];
      if (!field) {
        throw new ToolError(
          "bad-token",
          `Unrecognized key "${keyRaw}" in "${token}".`,
          "Use keys like V, I, R, P, vin, vf, if, r1, r2, or vout.",
        );
      }

      if (field === "vf") {
        const vfMatch = valRaw.match(/^([+-]?\d*\.?\d+)\s*[xX]\s*(\d+)$/);
        if (vfMatch) {
          fields.vf = Number(vfMatch[1]);
          vfEmbeddedCount = Number.parseInt(vfMatch[2], 10);
          continue;
        }
      }

      const { value } = parseNumberUnit(valRaw, token);
      fields[field] = value;
      continue;
    }

    // Bare token: the unit determines which quantity it fills.
    const { value, kind } = parseNumberUnit(token, token);
    if (!kind) {
      throw new ToolError(
        "bad-token",
        `Could not determine what "${token}" measures.`,
        "Add a unit like V, A, W, or ohm, or use key=value syntax such as R=100.",
      );
    }
    fields[kind] = value;
  }

  return { fields, count: count ?? vfEmbeddedCount };
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

/** Nearest standard series value (E12/E24) at or above `exact`, searched across nearby decades. */
function nearestStandardAtOrAbove(exact: number, series: number[]): number {
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

function recommendedWattage(actualPowerW: number): string {
  const needed = actualPowerW * 2;
  const found = WATTAGES.find((w) => w >= needed);
  return found !== undefined ? `${found} W` : "5 W (exceeds standard ratings, use a power resistor)";
}

// ---------------------------------------------------------------------------
// Mode: ohms-law
// ---------------------------------------------------------------------------

function runOhmsLaw(fields: Partial<Record<Field, number>>): OhmsLawResult {
  const quantities: Quantity[] = ["V", "I", "R", "P"];
  const given = quantities.filter((q) => fields[q] !== undefined);

  if (given.length < 2) {
    throw new ToolError(
      "need-two",
      `Provide at least two of voltage, current, resistance, or power. Got ${
        given.length === 0 ? "none" : given.map((k) => QUANTITY_INFO[k].label).join(", ")
      }.`,
      'Try "12V 100mA" or "R=4.7k P=2W".',
    );
  }

  for (const q of given) assertPositive(QUANTITY_INFO[q].label, fields[q] as number);

  const V0 = fields.V;
  const I0 = fields.I;
  const R0 = fields.R;
  const P0 = fields.P;

  let full: Record<Quantity, number>;
  let usedPair: [Quantity, Quantity];
  let formula: string;

  if (V0 !== undefined && I0 !== undefined) {
    const R = V0 / I0;
    const P = V0 * I0;
    full = { V: V0, I: I0, R, P };
    usedPair = ["V", "I"];
    formula = "R = V / I; P = V x I";
  } else if (V0 !== undefined && R0 !== undefined) {
    const I = V0 / R0;
    const P = V0 * I;
    full = { V: V0, I, R: R0, P };
    usedPair = ["V", "R"];
    formula = "I = V / R; P = V x I";
  } else if (V0 !== undefined && P0 !== undefined) {
    const I = P0 / V0;
    const R = V0 / I;
    full = { V: V0, I, R, P: P0 };
    usedPair = ["V", "P"];
    formula = "I = P / V; R = V / I";
  } else if (I0 !== undefined && R0 !== undefined) {
    const V = I0 * R0;
    const P = I0 * I0 * R0;
    full = { V, I: I0, R: R0, P };
    usedPair = ["I", "R"];
    formula = "V = I x R; P = I^2 x R";
  } else if (I0 !== undefined && P0 !== undefined) {
    const V = P0 / I0;
    const R = V / I0;
    full = { V, I: I0, R, P: P0 };
    usedPair = ["I", "P"];
    formula = "V = P / I; R = V / I";
  } else {
    // R and P given.
    const R = R0 as number;
    const P = P0 as number;
    const V = Math.sqrt(P * R);
    const I = Math.sqrt(P / R);
    full = { V, I, R, P };
    usedPair = ["R", "P"];
    formula = "V = sqrt(P x R); I = sqrt(P / R)";
  }

  const extras = given.filter((k) => !usedPair.includes(k));
  for (const k of extras) {
    const givenVal = fields[k] as number;
    const computedVal = full[k];
    const relErr = Math.abs(givenVal - computedVal) / Math.max(Math.abs(computedVal), 1e-12);
    if (relErr > 0.01) {
      throw new ToolError(
        "impossible",
        `Given ${QUANTITY_INFO[k].label} (${formatEng(givenVal, QUANTITY_INFO[k].unit)}) does not match the value computed from the other inputs (${formatEng(computedVal, QUANTITY_INFO[k].unit)}, off by ${(relErr * 100).toFixed(1)}%).`,
        "Only two independent values are needed: V, I, R, and P are related by V = I x R and P = V x I. Check your inputs.",
      );
    }
  }

  const result: OhmsLawResult = {
    Voltage: formatEng(full.V, "V"),
    Current: formatEng(full.I, "A"),
    Resistance: formatEng(full.R, "ohm"),
    Power: formatEng(full.P, "W"),
    Formula: formula,
    Summary: `At ${formatEng(full.V, "V")} and ${formatEng(full.I, "A")}, this draws ${formatEng(full.P, "W")} through ${formatEng(full.R, "ohm")} of resistance.`,
  };
  if (extras.length > 0) result["Consistency check"] = "All given values agree within 1%.";
  return result;
}

// ---------------------------------------------------------------------------
// Mode: led-resistor
// ---------------------------------------------------------------------------

function runLedResistor(fields: Partial<Record<Field, number>>, count: number | undefined): OhmsLawResult {
  const missing: string[] = [];
  if (fields.vin === undefined) missing.push("vin");
  if (fields.vf === undefined) missing.push("vf");
  if (missing.length > 0) {
    throw new ToolError(
      "missing-values",
      `led-resistor mode needs ${missing.join(" and ")} (for example "vin=12 vf=2.1").`,
      "Provide vin (supply voltage) and vf (LED forward voltage per LED).",
    );
  }

  const vin = fields.vin as number;
  const vfPerLed = fields.vf as number;
  let ifVal = fields.if;
  let ifAssumed = false;
  if (ifVal === undefined) {
    ifVal = 0.02;
    ifAssumed = true;
  }

  assertPositive("vin", vin);
  assertPositive("vf", vfPerLed);
  assertPositive("if", ifVal);

  const ledCount = count ?? 1;
  if (!Number.isFinite(ledCount) || ledCount < 1) {
    throw new ToolError("impossible", `count must be a positive whole number, got ${ledCount}.`, "Use count=1 or more.");
  }

  const vfTotal = vfPerLed * ledCount;
  if (vin <= vfTotal) {
    throw new ToolError(
      "impossible",
      `Supply must exceed forward voltage: vin (${formatEng(vin, "V")}) is not greater than the total forward voltage (${formatEng(vfTotal, "V")}).`,
      "Increase vin or use fewer LEDs in series.",
    );
  }

  const exactR = (vin - vfTotal) / ifVal;
  const e12 = nearestStandardAtOrAbove(exactR, E12);
  const e24 = nearestStandardAtOrAbove(exactR, E24);

  const withResistor = (r: number) => {
    const actualI = (vin - vfTotal) / r;
    const p = (vin - vfTotal) * actualI;
    return { actualI, p, rating: recommendedWattage(p) };
  };
  const e12Info = withResistor(e12);
  const e24Info = withResistor(e24);

  const result: OhmsLawResult = {};
  if (ledCount > 1) result["LED count"] = String(ledCount);
  result["Total forward voltage"] = formatEng(vfTotal, "V");
  result["Exact resistor value"] = formatEng(exactR, "ohm");
  result["Next E12 value up"] = formatEng(e12, "ohm");
  result["E12 actual current"] = formatEng(e12Info.actualI, "A");
  result["E12 resistor power"] = formatEng(e12Info.p, "W");
  result["E12 recommended wattage"] = e12Info.rating;
  result["Next E24 value up"] = formatEng(e24, "ohm");
  result["E24 actual current"] = formatEng(e24Info.actualI, "A");
  result["E24 resistor power"] = formatEng(e24Info.p, "W");
  result["E24 recommended wattage"] = e24Info.rating;
  result["Formula"] = ledCount > 1 ? "R = (Vin - Vf total) / If; Vf total = Vf per LED x count" : "R = (Vin - Vf) / If";
  if (ifAssumed) result["Assumption"] = "No LED current given, so If was assumed to be 20 mA, a common indicator LED default.";
  return result;
}

// ---------------------------------------------------------------------------
// Mode: voltage-divider
// ---------------------------------------------------------------------------

function candidatesAroundDecades(exps: number[]): number[] {
  const vals: number[] = [];
  for (const exp of exps) for (const base of E24) vals.push(Math.round(base * 10 ** exp * 1e6) / 1e6);
  return vals;
}

function runVoltageDivider(fields: Partial<Record<Field, number>>): OhmsLawResult {
  if (fields.vin === undefined) {
    throw new ToolError(
      "missing-values",
      'voltage-divider mode needs vin (for example "vin=12 r1=1k r2=2k").',
      "Provide vin, the supply voltage across the divider.",
    );
  }
  const vin = fields.vin;
  assertPositive("vin", vin);

  const { r1, r2, vout } = fields;

  // Case 1: both resistors given -> forward compute.
  if (r1 !== undefined && r2 !== undefined) {
    assertPositive("r1", r1);
    assertPositive("r2", r2);
    const current = vin / (r1 + r2);
    const voutActual = (vin * r2) / (r1 + r2);
    const p1 = current * current * r1;
    const p2 = current * current * r2;
    return {
      Vout: formatEng(voutActual, "V"),
      Current: formatEng(current, "A"),
      "R1 power": formatEng(p1, "W"),
      "R2 power": formatEng(p2, "W"),
      Formula: "Vout = Vin x R2 / (R1 + R2)",
    };
  }

  if (vout === undefined) {
    throw new ToolError(
      "missing-values",
      "voltage-divider mode needs r1 and r2, or vout plus one resistor, or vout alone for suggestions.",
      'Try "vin=12 r1=1k r2=2k", "vin=12 vout=5 r1=10k", or "vin=12 vout=5".',
    );
  }
  assertPositive("vout", vout);
  if (vout >= vin) {
    throw new ToolError(
      "impossible",
      `vout (${formatEng(vout, "V")}) must be less than vin (${formatEng(vin, "V")}) for a resistive divider.`,
      "Choose a target vout below vin.",
    );
  }

  // Case 2: vin + vout + one resistor -> solve the other exactly, then suggest an E24 value.
  if (r1 !== undefined || r2 !== undefined) {
    if (r1 !== undefined) {
      assertPositive("r1", r1);
      const exactR2 = (r1 * vout) / (vin - vout);
      const decade = Math.floor(Math.log10(exactR2));
      const candidates = candidatesAroundDecades([decade - 1, decade, decade + 1]);
      let best = { r2: candidates[0], voutActual: 0, err: Infinity };
      for (const cand of candidates) {
        const voutActual = (vin * cand) / (r1 + cand);
        const err = Math.abs(voutActual - vout) / vout;
        if (err < best.err) best = { r2: cand, voutActual, err };
      }
      return {
        "R1 (given)": formatEng(r1, "ohm"),
        "Exact R2": formatEng(exactR2, "ohm"),
        "Nearest E24 R2": formatEng(best.r2, "ohm"),
        "Achieved Vout": formatEng(best.voutActual, "V"),
        Error: `${(best.err * 100).toFixed(2)}%`,
        Formula: "R2 = R1 x Vout / (Vin - Vout)",
      };
    }
    const r2v = r2 as number;
    assertPositive("r2", r2v);
    const exactR1 = (r2v * (vin - vout)) / vout;
    const decade = Math.floor(Math.log10(exactR1));
    const candidates = candidatesAroundDecades([decade - 1, decade, decade + 1]);
    let best = { r1: candidates[0], voutActual: 0, err: Infinity };
    for (const cand of candidates) {
      const voutActual = (vin * r2v) / (cand + r2v);
      const err = Math.abs(voutActual - vout) / vout;
      if (err < best.err) best = { r1: cand, voutActual, err };
    }
    return {
      "R2 (given)": formatEng(r2v, "ohm"),
      "Exact R1": formatEng(exactR1, "ohm"),
      "Nearest E24 R1": formatEng(best.r1, "ohm"),
      "Achieved Vout": formatEng(best.voutActual, "V"),
      Error: `${(best.err * 100).toFixed(2)}%`,
      Formula: "R1 = R2 x (Vin - Vout) / Vout",
    };
  }

  // Case 3: vin + vout only -> suggest three E24 pairs around 10k.
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

  const result: OhmsLawResult = {};
  top.forEach((t, i) => {
    result[`Suggestion ${i + 1}`] =
      `R1 = ${formatEng(t.r1, "ohm")}, R2 = ${formatEng(t.r2, "ohm")} -> Vout = ${formatEng(t.voutActual, "V")} (error ${(t.err * 100).toFixed(2)}%)`;
  });
  result.Formula = "Vout = Vin x R2 / (R1 + R2)";
  return result;
}

// ---------------------------------------------------------------------------

export function run(input: string, opts: OhmsLawOpts): OhmsLawResult {
  const { fields, count } = parseInput(input);
  const mode = opts.mode || "ohms-law";

  if (mode === "led-resistor") return runLedResistor(fields, count);
  if (mode === "voltage-divider") return runVoltageDivider(fields);
  return runOhmsLaw(fields);
}

export default { run } satisfies ToolLogic<string, OhmsLawResult, OhmsLawOpts>;

// Exported for tests only; not part of the tool's public logic surface.
export const __test__ = { formatEng, FIELD_LABEL };
