import { ToolError, type ToolLogic } from "../types";

/**
 * Buffer pH, buffer ratio and buffer capacity from Henderson-Hasselbalch.
 *
 *   pH = pKa + log10([A-] / [HA])
 *
 * Two directions are useful. Given the amounts of the weak acid and its
 * conjugate base, the equation gives the pH. Given a target pH, it gives the
 * ratio the two have to sit at, and with a total concentration it gives the
 * two amounts themselves.
 *
 * Both directions also report how far the buffer can be pushed. Adding a strong
 * base converts acid into conjugate base, so the tolerance before the pH climbs
 * a whole unit is
 *
 *   b = (R * HA - A) / (1 + R),  with R = 10 * ([A-] / [HA])
 *
 * and the mirror expression with R divided by ten gives the strong acid
 * tolerance. The differential buffer capacity is also printed:
 *
 *   beta = 2.303 * Ctotal * Ka * [H+] / (Ka + [H+])^2
 *
 * which is the moles of strong base per liter needed per unit of pH change at
 * the current point, and peaks at pH = pKa where it equals 0.576 * Ctotal.
 *
 * Henderson-Hasselbalch assumes the acid and base concentrations at equilibrium
 * are close to what you weighed out, which holds while both are far above the
 * hydrogen ion concentration. It also uses concentrations rather than
 * activities, so a real buffer at high ionic strength reads a little different
 * from the calculated value.
 *
 * This is a teaching and planning aid, not a measurement. Titrate to the pH you
 * want with a calibrated meter.
 */

export interface BufferPreset {
  id: string;
  label: string;
  /** pKa values at 25 C, in order of the ionization step. */
  pKa: number[];
  /** Approximate change in pKa per degree Celsius, where it matters. */
  dpKadT?: number;
  note?: string;
}

/**
 * Common laboratory buffers with their pKa values at 25 C, from the Good buffer
 * literature and the CRC Handbook tables of dissociation constants. Published
 * values vary in the second decimal between sources; these are the ones most
 * commonly quoted by buffer suppliers.
 */
export const BUFFERS: BufferPreset[] = [
  { id: "acetate", label: "Acetate (acetic acid)", pKa: [4.76] },
  { id: "formate", label: "Formate (formic acid)", pKa: [3.75] },
  {
    id: "citrate",
    label: "Citrate (citric acid)",
    pKa: [3.13, 4.76, 6.4],
    note: "Triprotic: pick the step nearest your target pH with the ionization step option.",
  },
  {
    id: "phosphate",
    label: "Phosphate",
    pKa: [2.15, 7.2, 12.35],
    note: "Triprotic: the second step at 7.20 is the one used for physiological buffers.",
  },
  {
    id: "carbonate",
    label: "Carbonate and bicarbonate",
    pKa: [6.35, 10.33],
    note: "Open to air the first step drifts, because dissolved carbon dioxide exchanges with the atmosphere.",
  },
  {
    id: "tris",
    label: "Tris",
    pKa: [8.06],
    dpKadT: -0.028,
    note: "Strongly temperature dependent: the pKa falls about 0.028 per degree, so a buffer set at room temperature is markedly different in the cold room.",
  },
  { id: "hepes", label: "HEPES", pKa: [7.48], dpKadT: -0.014 },
  { id: "mes", label: "MES", pKa: [6.15], dpKadT: -0.011 },
  { id: "mops", label: "MOPS", pKa: [7.2], dpKadT: -0.013 },
  { id: "pipes", label: "PIPES", pKa: [6.76], dpKadT: -0.0085 },
  { id: "bis-tris", label: "Bis-Tris", pKa: [6.46], dpKadT: -0.017 },
  { id: "tricine", label: "Tricine", pKa: [8.15], dpKadT: -0.021 },
  { id: "bicine", label: "Bicine", pKa: [8.35], dpKadT: -0.018 },
  { id: "taps", label: "TAPS", pKa: [8.4], dpKadT: -0.018 },
  { id: "ches", label: "CHES", pKa: [9.3], dpKadT: -0.011 },
  { id: "caps", label: "CAPS", pKa: [10.4], dpKadT: -0.009 },
  { id: "borate", label: "Borate (boric acid)", pKa: [9.24] },
  { id: "ammonium", label: "Ammonium (ammonia)", pKa: [9.25] },
  { id: "glycine", label: "Glycine", pKa: [2.35, 9.78] },
  { id: "imidazole", label: "Imidazole", pKa: [6.95], dpKadT: -0.02 },
];

const BUFFER_BY_ID: Record<string, BufferPreset> = {};
for (const b of BUFFERS) BUFFER_BY_ID[b.id] = b;

export interface BufferOpts {
  /** "ph" works the pH out from the amounts; "ratio" works the amounts out from a target pH. */
  mode: string;
  /** A BUFFERS id, or "none". */
  buffer: string;
  /** Which ionization step of a polyprotic preset to use, 1 based. */
  step: number;
  /** Temperature in degrees Celsius, for the presets that shift with it. */
  temperature: number;
  decimals: number;
  [key: string]: unknown;
}

export interface BufferFields {
  pKa?: number;
  acid?: number;
  base?: number;
  total?: number;
  targetPh?: number;
  volume?: number;
}

const KEY_ALIASES: Record<string, keyof BufferFields> = {
  pka: "pKa",
  ka: "pKa",
  acid: "acid",
  ha: "acid",
  weakacid: "acid",
  base: "base",
  a: "base",
  "a-": "base",
  conjugate: "base",
  salt: "base",
  total: "total",
  c: "total",
  ctotal: "total",
  concentration: "total",
  ph: "targetPh",
  target: "targetPh",
  targetph: "targetPh",
  v: "volume",
  volume: "volume",
};

function numberOf(raw: string, field: string): number {
  const cleaned = raw.trim().replace(/\s*(?:M|mM|mol|mol\/L|molar|mmol|mL|L)$/i, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n))
    throw new ToolError(
      "bad-number",
      `"${raw.trim()}" in ${field} is not a number.`,
      "Use a plain decimal number. Amounts may be concentrations or moles, because only their ratio matters.",
    );
  return n;
}

/** Read the free-form name=value input. */
export function parseFields(raw: string): BufferFields {
  const text = (raw ?? "").trim();
  if (!text)
    throw new ToolError(
      "empty-input",
      "No buffer to work out.",
      'Give the amounts, such as "pKa=4.76, HA=0.1, A=0.15", or a target, such as "pKa=4.76, pH=5.0, total=0.2".',
    );
  const PAIR =
    /([A-Za-z][A-Za-z0-9_-]*)\s*[=:]\s*([^,;\n]*?)(?=[,;\n]|\s+[A-Za-z][A-Za-z0-9_-]*\s*[=:]|$)/g;
  const pairs = [...text.matchAll(PAIR)];
  if (!pairs.length)
    throw new ToolError(
      "bad-input",
      "Nothing in that input looks like a value.",
      'Write values as name=value pairs, for example "pKa=4.76, HA=0.1, A=0.15".',
    );

  const fields: BufferFields = {};
  for (const pair of pairs) {
    const key = pair[1]!.trim().toLowerCase();
    const value = pair[2]!.trim();
    const field = KEY_ALIASES[key];
    if (!field)
      throw new ToolError(
        "unknown-field",
        `"${pair[1]}" is not a value this tool knows.`,
        "Use pKa, HA, A, total, pH and volume.",
      );
    if (key === "ka") {
      const ka = numberOf(value, "Ka");
      if (ka <= 0)
        throw new ToolError(
          "bad-ka",
          "Ka has to be greater than zero.",
          "Give Ka as a positive number, such as 1.8e-5, or give pKa instead.",
        );
      fields.pKa = -Math.log10(ka);
      continue;
    }
    fields[field] = numberOf(value, pair[1]!);
  }
  return fields;
}

export interface BufferResult {
  pKa: number;
  /** Where the pKa came from. */
  source: "typed" | "preset";
  preset?: BufferPreset;
  /** pKa before any temperature correction, when a preset supplied it. */
  presetPka?: number;
  ph: number;
  acid: number;
  base: number;
  total: number;
  ratio: number;
  /** Differential buffer capacity, in mol per liter per pH unit. */
  capacity: number;
  /** Strong base that can be added before the pH climbs one unit. */
  baseTolerance: number;
  /** Strong acid that can be added before the pH falls one unit. */
  acidTolerance: number;
  /** True while the target sits inside the useful pKa plus or minus one window. */
  inUsefulRange: boolean;
  mode: "ph" | "ratio";
  volume?: number;
}

/** Solve the buffer in whichever direction the mode asks for. */
export function solveBuffer(input: string, opts?: Partial<BufferOpts>): BufferResult {
  const fields = parseFields(input);
  const presetId = String(opts?.buffer ?? "none");
  const preset = BUFFER_BY_ID[presetId];
  const mode = String(opts?.mode ?? "ph") === "ratio" ? "ratio" : "ph";
  const rawStep = Number(opts?.step ?? 1);
  const rawTemp = Number(opts?.temperature ?? 25);
  const temperature = Number.isFinite(rawTemp) ? rawTemp : 25;

  let pKa = fields.pKa;
  let source: "typed" | "preset" = "typed";
  let presetPka: number | undefined;
  if (pKa === undefined && preset) {
    const step = Number.isFinite(rawStep) ? Math.round(rawStep) : 1;
    if (step < 1 || step > preset.pKa.length)
      throw new ToolError(
        "bad-step",
        `${preset.label} has ${preset.pKa.length} ionization step${preset.pKa.length === 1 ? "" : "s"}, so step ${step} does not exist.`,
        `Set the ionization step option between 1 and ${preset.pKa.length}.`,
      );
    presetPka = preset.pKa[step - 1]!;
    pKa = presetPka + (preset.dpKadT ?? 0) * (temperature - 25);
    source = "preset";
  }
  if (pKa === undefined)
    throw new ToolError(
      "no-pka",
      "No pKa was given, so there is no buffer to describe.",
      'Add a pKa, such as "pKa=4.76", give Ka instead, or pick a buffer preset.',
    );

  let acid: number;
  let base: number;
  let ph: number;

  if (mode === "ratio") {
    const target = fields.targetPh;
    if (target === undefined)
      throw new ToolError(
        "no-target",
        "Working the amounts out needs the pH you are aiming at.",
        'Add the target, such as "pH=5.0", or switch the mode to work the pH out from the amounts.',
      );
    const ratio = 10 ** (target - pKa);
    const total = fields.total ?? 1;
    if (total <= 0)
      throw new ToolError(
        "bad-total",
        "The total buffer concentration has to be greater than zero.",
        'Give a total, such as "total=0.2", or leave it out to get the answer as fractions of one.',
      );
    base = (total * ratio) / (1 + ratio);
    acid = total / (1 + ratio);
    ph = target;
  } else {
    acid = fields.acid ?? 0;
    base = fields.base ?? 0;
    if (fields.acid === undefined || fields.base === undefined) {
      if (fields.total !== undefined && fields.acid === undefined && fields.base !== undefined)
        acid = fields.total - fields.base;
      else if (fields.total !== undefined && fields.base === undefined && fields.acid !== undefined)
        base = fields.total - fields.acid;
      else
        throw new ToolError(
          "no-amounts",
          "Working the pH out needs both the weak acid and its conjugate base.",
          'Add both amounts, such as "HA=0.1, A=0.15". A total plus one of the two works as well.',
        );
    }
    if (acid <= 0 || base <= 0)
      throw new ToolError(
        "non-positive-amounts",
        "A buffer needs some of both the weak acid and its conjugate base, and one of the two came out at zero or below.",
        "Check the amounts. If one of them really is zero you have a plain weak acid or a plain salt, not a buffer.",
      );
    ph = pKa + Math.log10(base / acid);
  }

  const total = acid + base;
  const ratio = base / acid;
  const h = 10 ** -ph;
  const ka = 10 ** -pKa;
  const capacity = (2.302585092994046 * total * ka * h) / (ka + h) ** 2;
  const rUp = 10 * ratio;
  const rDown = ratio / 10;
  const baseTolerance = (rUp * acid - base) / (1 + rUp);
  const acidTolerance = (base - rDown * acid) / (1 + rDown);

  const result: BufferResult = {
    pKa,
    source,
    ph,
    acid,
    base,
    total,
    ratio,
    capacity,
    baseTolerance,
    acidTolerance,
    inUsefulRange: Math.abs(ph - pKa) <= 1,
    mode,
  };
  if (preset) result.preset = preset;
  if (presetPka !== undefined) result.presetPka = presetPka;
  if (fields.volume !== undefined) result.volume = fields.volume;
  return result;
}

function fmt(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs < 10 ** -decimals || abs >= 1e7) return value.toExponential(Math.max(2, decimals - 1));
  return value.toFixed(decimals);
}

function clampDecimals(value: unknown, fallback = 4): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(8, Math.max(0, Math.round(n)));
}

/** The permanent educational note that rides along with every result. */
export const DISCLAIMER =
  "Educational reference, not a measurement. Henderson-Hasselbalch uses concentrations rather than activities and assumes the equilibrium amounts match what you weighed out, so titrate to the pH you want with a calibrated meter before anything depends on it.";

export function run(input: string, opts?: Partial<BufferOpts>): Record<string, string> {
  const r = solveBuffer(input, opts);
  const d = clampDecimals(opts?.decimals ?? 4);
  const out: Record<string, string> = {};

  if (r.preset) {
    out["Buffer"] = r.preset.label;
    if (r.source === "preset" && r.presetPka !== undefined && r.presetPka !== r.pKa)
      out["pKa at 25 C"] = r.presetPka.toFixed(3);
    if (r.preset.note) out["Buffer note"] = r.preset.note;
  }
  out["pKa used"] = `${r.pKa.toFixed(3)} (${r.source === "preset" ? "from the preset" : "as you typed it"})`;
  out["Ka"] = fmt(10 ** -r.pKa, d);
  out["pH"] = r.ph.toFixed(Math.max(2, d));
  out["Conjugate base [A-]"] = fmt(r.base, d);
  out["Weak acid [HA]"] = fmt(r.acid, d);
  out["Base to acid ratio"] = `${fmt(r.ratio, d)} to 1`;
  out["Total buffer"] = fmt(r.total, d);
  out["Useful range"] = `pH ${(r.pKa - 1).toFixed(2)} to ${(r.pKa + 1).toFixed(2)} (pKa plus or minus one)`;
  out["Range check"] = r.inUsefulRange
    ? "Inside the useful range, so the buffer resists change well here."
    : "Outside the useful range: one component is more than ten times the other, so this mixture buffers weakly at this pH.";
  out["Buffer capacity"] =
    `${fmt(r.capacity, d)} mol per liter per pH unit (peaks at ${fmt(0.5756462732485114 * r.total, d)} when the pH equals the pKa)`;
  out["Strong base tolerated"] =
    r.baseTolerance > 0
      ? `${fmt(r.baseTolerance, d)} before the pH rises a full unit to ${(r.ph + 1).toFixed(2)}`
      : "none, the pH is already more than a unit above the pKa";
  out["Strong acid tolerated"] =
    r.acidTolerance > 0
      ? `${fmt(r.acidTolerance, d)} before the pH falls a full unit to ${(r.ph - 1).toFixed(2)}`
      : "none, the pH is already more than a unit below the pKa";

  if (r.volume !== undefined && r.volume > 0) {
    out["Volume"] = `${fmt(r.volume, d)} L`;
    out["Moles of conjugate base"] = `${fmt(r.base * r.volume, d)} mol`;
    out["Moles of weak acid"] = `${fmt(r.acid * r.volume, d)} mol`;
  }

  out["How to prepare"] =
    r.mode === "ratio"
      ? `Mix the weak acid and its conjugate base in the ratio ${fmt(r.ratio, d)} to 1, which is ${fmt(r.acid, d)} of acid to ${fmt(r.base, d)} of base for a total of ${fmt(r.total, d)}, then check the pH on a meter and adjust.`
      : `That mixture buffers at pH ${r.ph.toFixed(2)}. To move it, add strong base to raise the pH or strong acid to lower it, then check the pH on a meter.`;
  out["Note"] = DISCLAIMER;
  return out;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, Partial<BufferOpts>>;
