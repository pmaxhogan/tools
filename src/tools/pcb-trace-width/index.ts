import { ToolError, type ToolLogic } from "../types";

export interface PcbTraceOpts {
  /** "width-for-current" | "current-for-width" */
  mode: string;
  /** "external" | "internal" */
  layer: string;
  /** "0.5" | "1" | "2" */
  copperWeight: string;
  [key: string]: unknown;
}

export type PcbTraceResult = Record<string, string>;

// ---------------------------------------------------------------------------
// Shared numeric formatting helpers
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

/** Parse a trace width: a number with an optional "mil"/"mils" or "mm" suffix, default mil. Returns mils. */
function parseWidthValue(v: string, tokenForError: string): number {
  const m = v.match(/^([+-]?\d*\.?\d+)\s*(mils|mil|mm)?$/i);
  if (!m || m[1] === "") {
    throw new ToolError(
      "bad-token",
      `Could not parse width "${tokenForError}".`,
      "Use a number with mil or mm, like 20mil or 0.5mm.",
    );
  }
  const num = Number(m[1]);
  if (!Number.isFinite(num)) {
    throw new ToolError("bad-token", `Could not parse width "${tokenForError}".`);
  }
  const unit = (m[2] || "mil").toLowerCase();
  if (unit === "mm") return num / 0.0254;
  return num;
}

/** Parse a trace length: a number with an optional m/meter(s) or ft/feet/foot suffix, default meters. Returns meters. */
function parseLengthValue(v: string, tokenForError: string): number {
  const m = v.match(/^([+-]?\d*\.?\d+)\s*(meters|meter|m|feet|foot|ft)?$/i);
  if (!m || m[1] === "") {
    throw new ToolError(
      "bad-token",
      `Could not parse length "${tokenForError}".`,
      "Use a number with m or ft, like 0.1m or 4ft.",
    );
  }
  const num = Number(m[1]);
  if (!Number.isFinite(num)) {
    throw new ToolError("bad-token", `Could not parse length "${tokenForError}".`);
  }
  const unit = (m[2] || "m").toLowerCase();
  if (unit.startsWith("ft") || unit.startsWith("feet") || unit.startsWith("foot"))
    return num * 0.3048;
  return num;
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

// ---------------------------------------------------------------------------
// Free-text token parsing: current=3, width=20mil, temprise=10, length=0.1m
// ---------------------------------------------------------------------------

type FieldKind = "current" | "width" | "temprise" | "length";

const KEY_FIELD: Record<string, FieldKind> = {
  current: "current",
  i: "current",
  amps: "current",
  a: "current",
  width: "width",
  w: "width",
  temprise: "temprise",
  dt: "temprise",
  rise: "temprise",
  deltat: "temprise",
  length: "length",
  l: "length",
  len: "length",
};

interface Fields {
  current?: number;
  widthMils?: number;
  tempRiseC?: number;
  lengthM?: number;
}

/** Tokenize "current=3 temprise=10 length=0.1m" style input. */
function parseTraceTokens(raw: string): Fields {
  const tokens = raw.split(/[\s,]+/).filter(Boolean);
  const fields: Fields = {};

  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq <= 0) {
      throw new ToolError(
        "bad-token",
        `Could not determine what "${token}" means.`,
        "Use key=value syntax, like current=3, width=20mil, temprise=10, or length=0.1m.",
      );
    }
    const keyRaw = token.slice(0, eq).toLowerCase();
    const valRaw = token.slice(eq + 1);
    const kind = KEY_FIELD[keyRaw];
    if (!kind) {
      throw new ToolError(
        "bad-token",
        `Unrecognized key "${keyRaw}" in "${token}".`,
        "Use keys like current, width, temprise, or length.",
      );
    }
    switch (kind) {
      case "current":
        fields.current = parseUnitNumber(valRaw, "current");
        break;
      case "width":
        fields.widthMils = parseWidthValue(valRaw, token);
        break;
      case "temprise":
        fields.tempRiseC = parseUnitNumber(valRaw, "temperature rise");
        break;
      case "length":
        fields.lengthM = parseLengthValue(valRaw, token);
        break;
    }
  }

  return fields;
}

// ---------------------------------------------------------------------------
// IPC-2221 constants
// ---------------------------------------------------------------------------

/** IPC-2221 empirical constant k: external (surface) traces dissipate heat far better than internal ones. */
const LAYER_K: Record<string, number> = { external: 0.0647, internal: 0.0021 };

/** Standard copper weight (oz/ft^2) to thickness (mils): 1 oz = 1.378 mils. */
const COPPER_THICKNESS_MILS: Record<string, number> = { "0.5": 0.689, "1": 1.378, "2": 2.756 };

/** Bulk copper resistivity, ohm.meter, at 20C. See the "Note" row for the hedge on this baseline. */
const RHO_OHM_M = 1.724e-8;

const TABLE_CURRENTS = [0.5, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const RESISTIVITY_NOTE =
  "Resistance, voltage drop, and power loss use bulk copper resistivity at 20C as a baseline. Real traces run hotter, and copper resistivity rises about 0.393 percent per degree C, so actual resistance is somewhat higher than this baseline calculation, especially at a high temperature rise target.";

const IPC_2152_NOTE =
  "IPC-2152 (2009) is a newer, more conservative standard that also accounts for board thickness, trace location, and nearby traces. It generally calls for wider traces than this classic IPC-2221 formula for the same current and temperature rise. This calculator implements IPC-2221 only. For a safety-critical high-current design, cross check against IPC-2152 charts or your fab's capability.";

function resolveLayer(layer: string): { k: number; label: string } {
  const l = (layer || "external").toLowerCase();
  if (!(l in LAYER_K)) {
    throw new ToolError(
      "bad-option",
      `Unrecognized layer "${layer}".`,
      "Use external or internal.",
    );
  }
  return { k: LAYER_K[l], label: l };
}

function resolveCopperWeight(copperWeight: string): { thicknessMils: number; label: string } {
  const c = String(copperWeight ?? "1");
  if (!(c in COPPER_THICKNESS_MILS)) {
    throw new ToolError(
      "bad-option",
      `Unrecognized copper weight "${copperWeight}".`,
      "Use 0.5, 1, or 2 oz.",
    );
  }
  return { thicknessMils: COPPER_THICKNESS_MILS[c], label: `${c} oz` };
}

interface ResistanceInfo {
  rPerM: number;
  rPerInch: number;
}

/** Resistance per unit length for a trace of the given width and thickness (both mils), at 20C. */
function computeResistancePerLength(widthMils: number, thicknessMils: number): ResistanceInfo {
  const widthMm = widthMils * 0.0254;
  const thicknessMm = thicknessMils * 0.0254;
  const areaM2 = (widthMm / 1000) * (thicknessMm / 1000);
  const rPerM = RHO_OHM_M / areaM2;
  return { rPerM, rPerInch: rPerM * 0.0254 };
}

/** Reference table of required width across a fixed current range, at the same temp rise / layer / copper weight. */
function buildTable(k: number, tempRiseC: number, thicknessMils: number): [string, string][] {
  return TABLE_CURRENTS.map((amps) => {
    const areaMils2 = (amps / (k * Math.pow(tempRiseC, 0.4281))) ** (1 / 0.6732);
    const widthMils = areaMils2 / thicknessMils;
    const widthMm = widthMils * 0.0254;
    return [`Table: ${amps} A`, `${widthMils.toFixed(1)} mil (${widthMm.toFixed(3)} mm)`] as [
      string,
      string,
    ];
  });
}

function addLengthRows(out: PcbTraceResult, lengthM: number, current: number, rPerM: number): void {
  const totalR = rPerM * lengthM;
  const vdrop = current * totalR;
  const ploss = current * current * totalR;
  out["Trace length"] = `${lengthM.toFixed(4)} m (${(lengthM / 0.3048).toFixed(3)} ft)`;
  out["Total resistance"] = formatEng(totalR, "ohm");
  out["Voltage drop"] = formatEng(vdrop, "V");
  out["Power loss"] = formatEng(ploss, "W");
}

// ---------------------------------------------------------------------------
// Mode: width-for-current
// ---------------------------------------------------------------------------

function runWidthForCurrent(raw: string, opts: PcbTraceOpts): PcbTraceResult {
  const f = parseTraceTokens(raw);
  if (f.current === undefined) {
    throw new ToolError(
      "missing-values",
      "width-for-current mode needs a current value.",
      'Try "current=3" or "current=3 temprise=10 length=0.1m".',
    );
  }
  assertPositive("current", f.current);

  const tempRiseGiven = f.tempRiseC !== undefined;
  const tempRiseC = f.tempRiseC ?? 10;
  if (tempRiseGiven) assertPositive("temprise", tempRiseC);
  if (f.lengthM !== undefined) assertPositive("length", f.lengthM);

  const { k, label: layerLabel } = resolveLayer(opts.layer);
  const { thicknessMils, label: cwLabel } = resolveCopperWeight(opts.copperWeight);

  const areaMils2 = (f.current / (k * Math.pow(tempRiseC, 0.4281))) ** (1 / 0.6732);
  const widthMils = areaMils2 / thicknessMils;
  const widthMm = widthMils * 0.0254;

  const out: PcbTraceResult = {};
  out["Required width (mil)"] = `${widthMils.toFixed(2)} mil`;
  out["Required width (mm)"] = `${widthMm.toFixed(4)} mm`;
  out["Cross-section area"] = `${areaMils2.toFixed(1)} mil2`;
  out["Copper thickness"] = `${cwLabel} (${thicknessMils.toFixed(3)} mil)`;
  out["Layer"] = layerLabel;
  out["Temperature rise used"] = `${tempRiseC} C${tempRiseGiven ? "" : " (default)"}`;

  const { rPerM, rPerInch } = computeResistancePerLength(widthMils, thicknessMils);
  out["Resistance per length"] = `${formatEng(rPerM, "ohm/m")} (${formatEng(rPerInch, "ohm/in")})`;

  if (f.lengthM !== undefined) addLengthRows(out, f.lengthM, f.current, rPerM);

  out["Note"] = RESISTIVITY_NOTE;
  out["IPC-2152 note"] = IPC_2152_NOTE;

  for (const [key, val] of buildTable(k, tempRiseC, thicknessMils)) out[key] = val;

  return out;
}

// ---------------------------------------------------------------------------
// Mode: current-for-width
// ---------------------------------------------------------------------------

function runCurrentForWidth(raw: string, opts: PcbTraceOpts): PcbTraceResult {
  const f = parseTraceTokens(raw);
  if (f.widthMils === undefined) {
    throw new ToolError(
      "missing-values",
      "current-for-width mode needs a width value.",
      'Try "width=20mil" or "width=0.5mm temprise=10".',
    );
  }
  assertPositive("width", f.widthMils);

  const tempRiseGiven = f.tempRiseC !== undefined;
  const tempRiseC = f.tempRiseC ?? 10;
  if (tempRiseGiven) assertPositive("temprise", tempRiseC);
  if (f.lengthM !== undefined) assertPositive("length", f.lengthM);

  const { k, label: layerLabel } = resolveLayer(opts.layer);
  const { thicknessMils, label: cwLabel } = resolveCopperWeight(opts.copperWeight);

  const widthMils = f.widthMils;
  const areaMils2 = widthMils * thicknessMils;
  const maxCurrent = k * Math.pow(tempRiseC, 0.4281) * Math.pow(areaMils2, 0.6732);
  const widthMm = widthMils * 0.0254;

  const out: PcbTraceResult = {};
  out["Maximum current"] = `${maxCurrent.toFixed(3)} A`;
  out["Width used"] = `${widthMils.toFixed(2)} mil (${widthMm.toFixed(4)} mm)`;
  out["Cross-section area"] = `${areaMils2.toFixed(1)} mil2`;
  out["Copper thickness"] = `${cwLabel} (${thicknessMils.toFixed(3)} mil)`;
  out["Layer"] = layerLabel;
  out["Temperature rise used"] = `${tempRiseC} C${tempRiseGiven ? "" : " (default)"}`;

  const { rPerM, rPerInch } = computeResistancePerLength(widthMils, thicknessMils);
  out["Resistance per length"] = `${formatEng(rPerM, "ohm/m")} (${formatEng(rPerInch, "ohm/in")})`;

  if (f.lengthM !== undefined) addLengthRows(out, f.lengthM, maxCurrent, rPerM);

  out["Note"] = RESISTIVITY_NOTE;
  out["IPC-2152 note"] = IPC_2152_NOTE;

  for (const [key, val] of buildTable(k, tempRiseC, thicknessMils)) out[key] = val;

  return out;
}

// ---------------------------------------------------------------------------

export function run(input: string, opts: PcbTraceOpts): PcbTraceResult {
  const raw = (input ?? "").trim();
  if (!raw) {
    throw new ToolError(
      "empty-input",
      "Enter a current or width value to calculate.",
      'Try "current=3" for width-for-current mode, or "width=20mil" for current-for-width mode.',
    );
  }

  const mode = opts.mode || "width-for-current";
  if (mode === "current-for-width") return runCurrentForWidth(raw, opts);
  if (mode === "width-for-current") return runWidthForCurrent(raw, opts);
  throw new ToolError(
    "bad-option",
    `Unrecognized mode "${mode}".`,
    "Use width-for-current or current-for-width.",
  );
}

export default { run } satisfies ToolLogic<string, PcbTraceResult, PcbTraceOpts>;
