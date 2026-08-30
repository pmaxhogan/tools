import { ToolError, type ToolLogic } from "../types";

/**
 * pH, pOH and the two ion concentrations, plus strong and weak acid and base
 * equilibria.
 *
 * Everything hangs off the ion product of water at the chosen temperature:
 *
 *   Kw = [H+][OH-],  pKw = -log10 Kw,  pH + pOH = pKw
 *
 * Kw is strongly temperature dependent, so a neutral solution is only pH 7.00
 * at 25 C. At 50 C neutral is about pH 6.63 and at 0 C about pH 7.47. The
 * temperature option changes Kw and every value derived from it, and the
 * neutral pH is always printed alongside the answer so an acidic or basic call
 * is made against the right reference.
 *
 * A strong acid is solved with water autoionization included, from
 * [H+]^2 - C[H+] - Kw = 0, so a 1e-8 M strong acid comes out just below neutral
 * rather than at the impossible pH 8 that the naive -log C gives.
 *
 * A weak acid is solved from the full quadratic x^2 + Ka x - Ka C = 0 rather
 * than the usual x = sqrt(Ka C) shortcut, and the output says whether the
 * shortcut would have been within the customary five percent.
 *
 * This is a teaching and planning aid, not a clinical or safety measurement.
 * A calculated pH assumes ideal dilute behavior and ignores ionic strength, so
 * measure with a calibrated meter before anything depends on the number.
 */

/**
 * pKw against temperature in degrees Celsius, from the CRC Handbook of
 * Chemistry and Physics table for the ionization constant of water.
 */
export const PKW_TABLE: { celsius: number; pKw: number }[] = [
  { celsius: 0, pKw: 14.943 },
  { celsius: 10, pKw: 14.535 },
  { celsius: 15, pKw: 14.346 },
  { celsius: 20, pKw: 14.167 },
  { celsius: 25, pKw: 13.997 },
  { celsius: 30, pKw: 13.833 },
  { celsius: 35, pKw: 13.68 },
  { celsius: 40, pKw: 13.535 },
  { celsius: 45, pKw: 13.396 },
  { celsius: 50, pKw: 13.262 },
  { celsius: 55, pKw: 13.137 },
  { celsius: 60, pKw: 13.017 },
  { celsius: 70, pKw: 12.8 },
  { celsius: 80, pKw: 12.6 },
  { celsius: 90, pKw: 12.42 },
  { celsius: 100, pKw: 12.26 },
];

/** The pKw for a temperature, interpolated linearly between table rows. */
export function pKwAt(celsius: number): number {
  const first = PKW_TABLE[0]!;
  const last = PKW_TABLE[PKW_TABLE.length - 1]!;
  if (celsius <= first.celsius) return first.pKw;
  if (celsius >= last.celsius) return last.pKw;
  for (let i = 1; i < PKW_TABLE.length; i++) {
    const hi = PKW_TABLE[i]!;
    const lo = PKW_TABLE[i - 1]!;
    if (celsius <= hi.celsius) {
      const t = (celsius - lo.celsius) / (hi.celsius - lo.celsius);
      return lo.pKw + t * (hi.pKw - lo.pKw);
    }
  }
  return last.pKw;
}

export interface PhOpts {
  /** "convert" | "strong-acid" | "strong-base" | "weak-acid" | "weak-base" */
  mode: string;
  /** Temperature in degrees Celsius, as a string from the select. */
  temperature: string;
  /** Ionizable protons or hydroxides per formula unit, for a strong acid or base. */
  protons: number;
  decimals: number;
  [key: string]: unknown;
}

export interface PhFields {
  ph?: number;
  poh?: number;
  h?: number;
  oh?: number;
  concentration?: number;
  ka?: number;
  kb?: number;
}

const KEY_ALIASES: Record<string, keyof PhFields> = {
  ph: "ph",
  poh: "poh",
  h: "h",
  "h+": "h",
  h3o: "h",
  hplus: "h",
  oh: "oh",
  "oh-": "oh",
  ohminus: "oh",
  c: "concentration",
  conc: "concentration",
  concentration: "concentration",
  m: "concentration",
  molarity: "concentration",
  ka: "ka",
  kb: "kb",
};

/** Keys whose value is a p-scale number that gets converted to a constant. */
const P_ALIASES: Record<string, "ka" | "kb"> = {
  pka: "ka",
  pkb: "kb",
};

function numberOf(raw: string, field: string): number {
  const cleaned = raw.trim().replace(/\s*(?:M|mol\/L|molar)$/i, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n))
    throw new ToolError(
      "bad-number",
      `"${raw.trim()}" in ${field} is not a number.`,
      'Use a plain decimal or scientific number, such as 0.1 or 1.8e-5. Concentrations are in mol/L, so "0.1 M" works too.',
    );
  return n;
}

/** Read the free-form name=value input. */
export function parseFields(raw: string): PhFields {
  const text = (raw ?? "").trim();
  if (!text)
    throw new ToolError(
      "empty-input",
      "No value to work from.",
      'Give one of pH, pOH, [H+] or [OH-], or a concentration with an acid constant, such as "C=0.1, Ka=1.8e-5".',
    );
  const PAIR =
    /([A-Za-z][A-Za-z0-9_+-]*)\s*[=:]\s*([^,;\n]*?)(?=[,;\n]|\s+[A-Za-z][A-Za-z0-9_+-]*\s*[=:]|$)/g;
  const pairs = [...text.matchAll(PAIR)];
  if (!pairs.length) {
    // A bare number is read as a pH, which is what a single figure usually is.
    const bare = Number(text);
    if (Number.isFinite(bare)) return { ph: bare };
    throw new ToolError(
      "bad-input",
      "Nothing in that input looks like a value.",
      'Write values as name=value pairs, for example "pH=3.4" or "C=0.1, pKa=4.76".',
    );
  }

  const fields: PhFields = {};
  for (const pair of pairs) {
    const key = pair[1]!.trim().toLowerCase();
    const value = pair[2]!.trim();
    const pKey = P_ALIASES[key];
    if (pKey) {
      fields[pKey] = 10 ** -numberOf(value, pair[1]!);
      continue;
    }
    const field = KEY_ALIASES[key];
    if (!field)
      throw new ToolError(
        "unknown-field",
        `"${pair[1]}" is not a value this tool knows.`,
        "Use pH, pOH, H, OH, C, Ka, pKa, Kb or pKb.",
      );
    fields[field] = numberOf(value, pair[1]!);
  }
  return fields;
}

export interface PhResult {
  ph: number;
  poh: number;
  h: number;
  oh: number;
  pKw: number;
  kw: number;
  neutralPh: number;
  celsius: number;
  mode: string;
  /** Fraction of the acid or base that ionized, 0 to 1, for the weak modes. */
  ionized?: number;
  /** The equilibrium constant used, for the weak modes. */
  k?: number;
  /** Whether the sqrt(K C) shortcut would have landed within five percent. */
  fivePercentRuleHolds?: boolean;
  /** Relative error the shortcut would have carried, as a fraction. */
  shortcutError?: number;
  /** True when the answer sits close enough to neutral that water matters. */
  waterMatters?: boolean;
}

function requirePositive(value: number, name: string): number {
  if (!(value > 0))
    throw new ToolError(
      "not-positive",
      `${name} has to be greater than zero.`,
      "Concentrations and equilibrium constants are positive numbers; a p-scale value such as pKa may be negative.",
    );
  return value;
}

/** Solve for pH, pOH and both ion concentrations. */
export function solvePh(input: string, opts?: Partial<PhOpts>): PhResult {
  const fields = parseFields(input);
  const celsius = Number(opts?.temperature ?? 25);
  const temperature = Number.isFinite(celsius) ? celsius : 25;
  const pKw = pKwAt(temperature);
  const kw = 10 ** -pKw;
  const neutralPh = pKw / 2;
  const mode = String(opts?.mode ?? "convert");
  const rawProtons = Number(opts?.protons ?? 1);
  const protons = Number.isFinite(rawProtons) && rawProtons >= 1 ? Math.round(rawProtons) : 1;

  const base = { pKw, kw, neutralPh, celsius: temperature, mode };

  if (mode === "convert") {
    const given = (["ph", "poh", "h", "oh"] as const).filter((k) => fields[k] !== undefined);
    if (!given.length)
      throw new ToolError(
        "nothing-given",
        "Converting needs one of pH, pOH, [H+] or [OH-].",
        'Write one of them, such as "pH=3.4" or "H=2.5e-4". A bare number is read as a pH.',
      );
    if (given.length > 1)
      throw new ToolError(
        "too-many-given",
        `pH, pOH, [H+] and [OH-] are four views of the same equilibrium, and ${given.length} were given.`,
        "Keep the one you actually measured and delete the others.",
      );
    let h: number;
    if (fields.ph !== undefined) h = 10 ** -fields.ph;
    else if (fields.poh !== undefined) h = kw / 10 ** -fields.poh;
    else if (fields.h !== undefined) h = requirePositive(fields.h, "[H+]");
    else h = kw / requirePositive(fields.oh!, "[OH-]");
    const oh = kw / h;
    return { ...base, h, oh, ph: -Math.log10(h), poh: -Math.log10(oh) };
  }

  const c = fields.concentration;
  if (c === undefined)
    throw new ToolError(
      "no-concentration",
      "That mode needs the concentration of the acid or base.",
      'Add the concentration in mol/L, such as "C=0.1".',
    );
  if (c < 0)
    throw new ToolError(
      "negative-concentration",
      "A concentration cannot be negative.",
      "Give the concentration as a positive number of moles per liter.",
    );
  const total = c * protons;

  if (mode === "strong-acid" || mode === "strong-base") {
    // x^2 - total x - Kw = 0, taking water autoionization into account.
    const x = (total + Math.sqrt(total * total + 4 * kw)) / 2;
    const h = mode === "strong-acid" ? x : kw / x;
    const oh = kw / h;
    return {
      ...base,
      h,
      oh,
      ph: -Math.log10(h),
      poh: -Math.log10(oh),
      ionized: 1,
      waterMatters: total < 1e-6,
    };
  }

  if (mode === "weak-acid" || mode === "weak-base") {
    const k = mode === "weak-acid" ? fields.ka : fields.kb;
    if (k === undefined)
      throw new ToolError(
        "no-constant",
        `That mode needs ${mode === "weak-acid" ? "Ka or pKa" : "Kb or pKb"}.`,
        mode === "weak-acid"
          ? 'Add the acid constant, such as "Ka=1.8e-5" or "pKa=4.76".'
          : 'Add the base constant, such as "Kb=1.8e-5" or "pKb=4.75".',
      );
    requirePositive(k, mode === "weak-acid" ? "Ka" : "Kb");
    if (total === 0)
      throw new ToolError(
        "zero-concentration",
        "A concentration of zero leaves pure water, which the convert mode already describes.",
        'Give a concentration greater than zero, or switch the mode to "From pH, pOH or an ion concentration".',
      );
    // x^2 + K x - K C = 0, the exact quadratic rather than x = sqrt(K C).
    const x = (-k + Math.sqrt(k * k + 4 * k * total)) / 2;
    const shortcut = Math.sqrt(k * total);
    const h = mode === "weak-acid" ? x : kw / x;
    const oh = kw / h;
    return {
      ...base,
      h,
      oh,
      ph: -Math.log10(h),
      poh: -Math.log10(oh),
      ionized: x / total,
      k,
      fivePercentRuleHolds: shortcut / total <= 0.05,
      shortcutError: Math.abs(shortcut - x) / x,
      waterMatters: x < 10 * Math.sqrt(kw),
    };
  }

  throw new ToolError(
    "unknown-mode",
    `"${mode}" is not a calculation this tool offers.`,
    "Pick one of the modes in the options: convert, strong acid, strong base, weak acid or weak base.",
  );
}

function fmt(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs < 1e-3 || abs >= 1e6) return value.toExponential(Math.max(2, decimals));
  return value.toFixed(decimals);
}

function clampDecimals(value: unknown, fallback = 3): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(6, Math.max(0, Math.round(n)));
}

/** The permanent educational note that rides along with every result. */
export const DISCLAIMER =
  "Educational reference, not a measurement. These values assume ideal dilute solutions at equilibrium and ignore ionic strength and activity coefficients, so read a calibrated meter before anything depends on the number.";

export function run(input: string, opts?: Partial<PhOpts>): Record<string, string> {
  const r = solvePh(input, opts);
  const d = clampDecimals(opts?.decimals ?? 3);

  const out: Record<string, string> = {
    pH: r.ph.toFixed(d),
    pOH: r.poh.toFixed(d),
    "[H+]": `${fmt(r.h, d)} mol/L`,
    "[OH-]": `${fmt(r.oh, d)} mol/L`,
    Temperature: `${r.celsius} C`,
    "Kw at this temperature": `${fmt(r.kw, d)} (pKw ${r.pKw.toFixed(3)})`,
    "Neutral pH here": r.neutralPh.toFixed(3),
    Verdict:
      r.ph < r.neutralPh - 0.005
        ? "Acidic"
        : r.ph > r.neutralPh + 0.005
          ? "Basic"
          : "Neutral for this temperature",
  };

  if (r.k !== undefined) {
    const isAcid = r.mode === "weak-acid";
    out[isAcid ? "Ka" : "Kb"] = fmt(r.k, d);
    out[isAcid ? "pKa" : "pKb"] = (-Math.log10(r.k)).toFixed(3);
  }
  if (r.ionized !== undefined && r.mode.startsWith("weak"))
    out["Percent ionization"] = `${(r.ionized * 100).toFixed(Math.max(2, d))}%`;
  if (r.fivePercentRuleHolds !== undefined)
    out["Five percent rule"] = r.fivePercentRuleHolds
      ? `Would have held: the square root shortcut lands within ${(r.shortcutError! * 100).toFixed(2)}% of the exact quadratic.`
      : `Would not have held: the square root shortcut is off by ${(r.shortcutError! * 100).toFixed(2)}%, which is why the quadratic is solved here.`;
  if (r.mode.startsWith("weak"))
    out["Polyprotic note"] =
      "Only the first ionization step is modeled. For a diprotic or triprotic acid the second and third steps are usually far weaker and shift the pH very little, but they do matter for the species distribution.";
  if (r.waterMatters)
    out["Dilute solution note"] =
      "At this concentration the water autoionization contributes a real share of the ions. The strong acid and base modes solve for that exactly; the weak modes do not, so treat a very dilute weak acid result as approximate.";
  if ((r.mode === "strong-acid" || r.mode === "strong-base") && r.ionized === 1)
    out["Assumption"] =
      "The acid or base is taken as fully dissociated, which is the definition of strong. Multiply the concentration through the protons option for a diprotic acid such as sulfuric acid or a dihydroxide such as calcium hydroxide.";

  out["Note"] = DISCLAIMER;
  return out;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, Partial<PhOpts>>;
