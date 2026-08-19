import { ToolError, type ToolLogic } from "../types";

export interface WireGaugeOpts {
  /** "lookup" | "voltage-drop" | "size-for" */
  mode: string;
  [key: string]: unknown;
}

export type WireGaugeResult = Record<string, string>;

// ---------------------------------------------------------------------------
// AWG physics: diameter formula, derived properties
// ---------------------------------------------------------------------------

/**
 * AWG diameter formula, mm. `n` is the AWG number: 1..40 for the standard
 * sizes, and 0 / -1 / -2 / -3 for 1/0, 2/0, 3/0, 4/0 (the "ought" sizes).
 */
function diameterMm(n: number): number {
  return 0.127 * Math.pow(92, (36 - n) / 39);
}

/** Cross-sectional area of an AWG size, mm^2, derived from `diameterMm`. */
function awgAreaMm2(n: number): number {
  const d = diameterMm(n);
  return (Math.PI / 4) * d * d;
}

/** "4/0", "3/0", "2/0", "1/0" for the ought sizes; otherwise the number itself. */
function gaugeLabel(n: number): string {
  if (n === -3) return "4/0";
  if (n === -2) return "3/0";
  if (n === -1) return "2/0";
  if (n === 0) return "1/0";
  return String(n);
}

interface WireProps {
  diameterMm: number;
  diameterIn: number;
  cmils: number;
  rCuPerKm: number;
  rAlPerKm: number;
}

/**
 * Derived properties from a cross-sectional area (mm^2) alone, so the same
 * math serves both AWG sizes and arbitrary metric mm^2 sizes. Resistivity:
 * copper 1.724e-8 ohm.m, aluminum 2.65e-8 ohm.m at 20C, giving
 * ohm/km = rho * 1e9 / area_mm2.
 */
function wireProps(areaMm2: number): WireProps {
  const d = Math.sqrt((4 * areaMm2) / Math.PI);
  const mils = (d * 1000) / 25.4;
  return {
    diameterMm: d,
    diameterIn: d / 25.4,
    cmils: mils * mils,
    rCuPerKm: 17.24 / areaMm2,
    rAlPerKm: 26.5 / areaMm2,
  };
}

/** Nearest AWG size (by log-ratio distance, since gauges are geometric) to a given area. */
function nearestAwgForArea(areaMm2: number): number {
  let best = -3;
  let bestDiff = Infinity;
  for (let n = -3; n <= 40; n++) {
    const diff = Math.abs(Math.log(areaMm2 / awgAreaMm2(n)));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = n;
    }
  }
  return best;
}

const METRIC_SIZES = [0.5, 0.75, 1, 1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95];

/** Approximate ampacity for standard metric conductor sizes. Reference only: see the FAQ hedge. */
const METRIC_AMPACITY: Record<number, number> = {
  0.5: 3,
  0.75: 6,
  1: 10,
  1.5: 16,
  2.5: 24,
  4: 32,
  6: 41,
  10: 57,
  16: 76,
  25: 96,
  35: 119,
  50: 144,
  70: 184,
  95: 223,
};

/** Nearest standard metric mm^2 size to a given area (log-ratio distance). */
function nearestMetricSize(areaMm2: number): number {
  let best = METRIC_SIZES[0];
  let bestDiff = Infinity;
  for (const s of METRIC_SIZES) {
    const diff = Math.abs(Math.log(areaMm2 / s));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Reference tables
// ---------------------------------------------------------------------------

interface NecEntry {
  cu60: number;
  cu75: number;
  cu90: number;
  /** Aluminum ampacity is only tabulated at the 75C column here. */
  al75?: number;
}

/** NEC 310.16-style ampacity for THHN/THWN-2 copper (and aluminum at 75C), common code sizes. */
const NEC_AMPACITY: Record<string, NecEntry> = {
  "14": { cu60: 15, cu75: 20, cu90: 25 },
  "12": { cu60: 20, cu75: 25, cu90: 30, al75: 20 },
  "10": { cu60: 30, cu75: 35, cu90: 40, al75: 30 },
  "8": { cu60: 40, cu75: 50, cu90: 55, al75: 40 },
  "6": { cu60: 55, cu75: 65, cu90: 75, al75: 50 },
  "4": { cu60: 70, cu75: 85, cu90: 95, al75: 65 },
  "3": { cu60: 85, cu75: 100, cu90: 115, al75: 75 },
  "2": { cu60: 95, cu75: 115, cu90: 130, al75: 90 },
  "1": { cu60: 110, cu75: 130, cu90: 145, al75: 100 },
  "1/0": { cu60: 125, cu75: 150, cu90: 170, al75: 120 },
  "2/0": { cu60: 145, cu75: 175, cu90: 195, al75: 135 },
  "3/0": { cu60: 165, cu75: 200, cu90: 225, al75: 155 },
  "4/0": { cu60: 195, cu75: 230, cu90: 260, al75: 180 },
};

/** AWG number -> NEC table label, for the sizes the table covers. */
const AWG_TO_NEC_LABEL: Record<number, string> = {
  14: "14",
  12: "12",
  10: "10",
  8: "8",
  6: "6",
  4: "4",
  3: "3",
  2: "2",
  1: "1",
  0: "1/0",
  [-1]: "2/0",
  [-2]: "3/0",
  [-3]: "4/0",
};

/** Ordered thinnest-to-thickest, for the "size-for" search. */
const NEC_ORDER: { label: string; n: number }[] = [
  { label: "14", n: 14 },
  { label: "12", n: 12 },
  { label: "10", n: 10 },
  { label: "8", n: 8 },
  { label: "6", n: 6 },
  { label: "4", n: 4 },
  { label: "3", n: 3 },
  { label: "2", n: 2 },
  { label: "1", n: 1 },
  { label: "1/0", n: 0 },
  { label: "2/0", n: -1 },
  { label: "3/0", n: -2 },
  { label: "4/0", n: -3 },
];

/**
 * Chassis-wiring / hobbyist open-air current reference (not a code table): the
 * commonly reprinted "chassis wiring vs power transmission" figures for small
 * gauges.
 */
const CHASSIS_TABLE: Record<number, { chassisA: number; powerA: number }> = {
  16: { chassisA: 22, powerA: 3.7 },
  18: { chassisA: 16, powerA: 2.3 },
  20: { chassisA: 11, powerA: 1.5 },
  22: { chassisA: 7, powerA: 0.92 },
  24: { chassisA: 3.5, powerA: 0.577 },
  26: { chassisA: 2.2, powerA: 0.361 },
  28: { chassisA: 1.4, powerA: 0.226 },
  30: { chassisA: 0.86, powerA: 0.142 },
};

// ---------------------------------------------------------------------------
// Wire-size token parsing: "12 awg", "4/0", "0000", "2.5 mm2", "12awg", "#12"
// ---------------------------------------------------------------------------

type SizeSpec = { kind: "awg"; n: number } | { kind: "metric"; mm2: number };

const AWG_SPECIAL: Record<string, number> = {
  "0000": -3,
  "4/0": -3,
  "000": -2,
  "3/0": -2,
  "00": -1,
  "2/0": -1,
  "0": 0,
  "1/0": 0,
};

/**
 * Parse a single wire-size token into either an AWG number or a metric mm^2
 * area. A bare 1-2 digit number defaults to AWG (this is a wire gauge tool);
 * a bare decimal defaults to metric mm^2, since AWG sizes are never fractional.
 */
function parseSizeSpec(raw: string): SizeSpec {
  const compact = raw.replace(/\s+/g, "").toLowerCase();

  const mm = compact.match(/^([+-]?\d*\.?\d+)(mm2|mm\^2|sqmm|mm²)$/);
  if (mm) {
    const v = Number(mm[1]);
    if (!(v > 0)) {
      throw new ToolError("unknown-gauge", `"${raw.trim()}" is not a valid metric wire size.`, "Use a positive number of mm2, like 2.5mm2.");
    }
    return { kind: "metric", mm2: v };
  }

  let core = compact.replace(/^#/, "");
  let suffixed = false;
  const suffixMatch = core.match(/^(.+?)(awg|gauge|ga)$/);
  if (suffixMatch && suffixMatch[1] !== "") {
    core = suffixMatch[1];
    suffixed = true;
  } else {
    const prefixMatch = core.match(/^(awg|gauge|ga)#?(.+)$/);
    if (prefixMatch) {
      core = prefixMatch[2];
      suffixed = true;
    }
  }

  if (core in AWG_SPECIAL) {
    return { kind: "awg", n: AWG_SPECIAL[core] };
  }

  if (/^\d{1,2}$/.test(core)) {
    const n = Number(core);
    if (n >= 1 && n <= 40) return { kind: "awg", n };
    throw new ToolError(
      "unknown-gauge",
      `"${raw.trim()}" is outside the AWG range (1 to 40, or 00 to 0000).`,
      "Use a gauge between 1 and 40, or 00, 000, 0000 (also written 2/0, 3/0, 4/0).",
    );
  }

  if (!suffixed) {
    const dec = compact.match(/^([+-]?\d*\.\d+)$/);
    if (dec) {
      const v = Number(dec[1]);
      if (!(v > 0)) {
        throw new ToolError("unknown-gauge", `"${raw.trim()}" is not a valid wire size.`, "Use a positive number of mm2, like 2.5mm2.");
      }
      return { kind: "metric", mm2: v };
    }
  }

  throw new ToolError(
    "unknown-gauge",
    `Could not recognize "${raw.trim()}" as a wire gauge or metric size.`,
    'Try formats like "12 awg", "4/0", "0000", or "2.5 mm2".',
  );
}

function resolveGaugeSpec(raw: string): { areaMm2: number; label: string } {
  const spec = parseSizeSpec(raw);
  if (spec.kind === "awg") return { areaMm2: awgAreaMm2(spec.n), label: `${gaugeLabel(spec.n)} AWG` };
  return { areaMm2: spec.mm2, label: `${spec.mm2} mm2` };
}

function looksLikeGaugeToken(t: string): boolean {
  if (/^#?\d{1,2}(awg|ga|gauge)$/i.test(t)) return true;
  if (/^(awg|gauge|ga)#?\d{1,2}$/i.test(t)) return true;
  if (t.toLowerCase() in AWG_SPECIAL) return true;
  if (/^\d*\.?\d+(mm2|mm\^2|sqmm|mm²)$/i.test(t)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Free-text token parsing for voltage-drop / size-for
// ---------------------------------------------------------------------------

type FieldKind = "current" | "length" | "gauge" | "voltage" | "material" | "phase" | "maxdrop" | "temp";

const KEY_FIELD: Record<string, FieldKind> = {
  i: "current",
  a: "current",
  amp: "current",
  amps: "current",
  current: "current",
  l: "length",
  len: "length",
  length: "length",
  dist: "length",
  distance: "length",
  g: "gauge",
  gauge: "gauge",
  awg: "gauge",
  wire: "gauge",
  size: "gauge",
  v: "voltage",
  volt: "voltage",
  volts: "voltage",
  voltage: "voltage",
  material: "material",
  mat: "material",
  metal: "material",
  conductor: "material",
  phase: "phase",
  ph: "phase",
  maxdrop: "maxdrop",
  drop: "maxdrop",
  limit: "maxdrop",
  percent: "maxdrop",
  pct: "maxdrop",
  maxpercent: "maxdrop",
  temp: "temp",
  column: "temp",
  col: "temp",
  rating: "temp",
  insulation: "temp",
};

interface Fields {
  current?: number;
  lengthM?: number;
  gaugeAreaMm2?: number;
  gaugeLabelText?: string;
  voltage?: number;
  material?: "copper" | "aluminum";
  phase?: "dc" | "ac1" | "ac3";
  maxDropPct?: number;
  tempColumn?: 60 | 75 | 90;
}

function normalizeMaterial(v: string, tokenForError: string): "copper" | "aluminum" {
  const s = v.toLowerCase();
  if (s === "copper" || s === "cu") return "copper";
  if (s === "aluminum" || s === "aluminium" || s === "al") return "aluminum";
  throw new ToolError("bad-token", `Unrecognized material "${tokenForError}".`, "Use copper or aluminum.");
}

function normalizePhase(v: string, tokenForError: string): "dc" | "ac1" | "ac3" {
  const s = v.toLowerCase();
  if (s === "dc") return "dc";
  if (["ac1", "single", "singlephase", "single-phase", "1p"].includes(s)) return "ac1";
  if (["ac3", "three", "threephase", "three-phase", "3p"].includes(s)) return "ac3";
  throw new ToolError("bad-token", `Unrecognized phase "${tokenForError}".`, "Use dc, ac1 (single-phase), or ac3 (three-phase).");
}

function parseLengthValue(v: string, tokenForError: string): number {
  const m = v.match(/^([+-]?\d*\.?\d+)\s*(m|meter|meters|metre|metres|ft|feet|foot)?$/i);
  if (!m || m[1] === "") {
    throw new ToolError("bad-token", `Could not parse length "${tokenForError}".`, "Use a number with m or ft, like 30m or 100ft.");
  }
  const num = Number(m[1]);
  if (!Number.isFinite(num)) throw new ToolError("bad-token", `Could not parse length "${tokenForError}".`);
  const unit = (m[2] || "m").toLowerCase();
  if (unit.startsWith("ft") || unit.startsWith("feet") || unit.startsWith("foot")) return num * 0.3048;
  return num;
}

function parsePlainNumber(v: string, label: string, tokenForError: string): number {
  const m = v.match(/^([+-]?\d*\.?\d+)\s*[a-zA-Z]*$/);
  if (!m || m[1] === "") {
    throw new ToolError("bad-token", `Could not parse ${label} "${tokenForError}".`, `Use a plain number for ${label}.`);
  }
  const num = Number(m[1]);
  if (!Number.isFinite(num)) throw new ToolError("bad-token", `Could not parse ${label} "${tokenForError}".`);
  return num;
}

function parsePercent(v: string, tokenForError: string): number {
  const s = v.endsWith("%") ? v.slice(0, -1) : v;
  const num = Number(s);
  if (!Number.isFinite(num) || s === "") {
    throw new ToolError("bad-token", `Could not parse percent "${tokenForError}".`, "Use a plain number like 3 or 3%.");
  }
  return num;
}

function parseTempColumn(v: string, tokenForError: string): 60 | 75 | 90 {
  const num = Number(v);
  if (num === 60 || num === 75 || num === 90) return num;
  throw new ToolError("bad-token", `Temperature column "${tokenForError}" must be 60, 75, or 90.`, "Use temp=60, temp=75, or temp=90.");
}

/** Tokenize "20A 30m 12awg 120V copper dc" / "i=20 l=30ft gauge=4/0 v=240" style input. */
function parseWireTokens(raw: string): Fields {
  const tokens = raw.split(/[\s,]+/).filter(Boolean);
  const fields: Fields = {};

  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq > 0) {
      const keyRaw = token.slice(0, eq).toLowerCase();
      const valRaw = token.slice(eq + 1);
      const kind = KEY_FIELD[keyRaw];
      if (!kind) {
        throw new ToolError(
          "bad-token",
          `Unrecognized key "${keyRaw}" in "${token}".`,
          "Use keys like current, length, gauge, voltage, material, phase, maxdrop, or temp.",
        );
      }
      switch (kind) {
        case "current":
          fields.current = parsePlainNumber(valRaw, "current", token);
          break;
        case "voltage":
          fields.voltage = parsePlainNumber(valRaw, "voltage", token);
          break;
        case "length":
          fields.lengthM = parseLengthValue(valRaw, token);
          break;
        case "gauge": {
          const g = resolveGaugeSpec(valRaw);
          fields.gaugeAreaMm2 = g.areaMm2;
          fields.gaugeLabelText = g.label;
          break;
        }
        case "material":
          fields.material = normalizeMaterial(valRaw, token);
          break;
        case "phase":
          fields.phase = normalizePhase(valRaw, token);
          break;
        case "maxdrop":
          fields.maxDropPct = parsePercent(valRaw, token);
          break;
        case "temp":
          fields.tempColumn = parseTempColumn(valRaw, token);
          break;
      }
      continue;
    }

    if (looksLikeGaugeToken(token)) {
      const g = resolveGaugeSpec(token);
      fields.gaugeAreaMm2 = g.areaMm2;
      fields.gaugeLabelText = g.label;
      continue;
    }

    const lower = token.toLowerCase();
    if (lower === "copper" || lower === "cu" || lower === "aluminum" || lower === "aluminium" || lower === "al") {
      fields.material = normalizeMaterial(lower, token);
      continue;
    }
    if (["dc", "ac1", "single", "singlephase", "single-phase", "1p", "ac3", "three", "threephase", "three-phase", "3p"].includes(lower)) {
      fields.phase = normalizePhase(lower, token);
      continue;
    }
    if (/^\d*\.?\d+%$/.test(token)) {
      fields.maxDropPct = parsePercent(token, token);
      continue;
    }

    const mA = token.match(/^([+-]?\d*\.?\d+)a$/i);
    if (mA) {
      fields.current = Number(mA[1]);
      continue;
    }
    const mV = token.match(/^([+-]?\d*\.?\d+)v$/i);
    if (mV) {
      fields.voltage = Number(mV[1]);
      continue;
    }
    const mM = token.match(/^([+-]?\d*\.?\d+)(m|meter|meters|metre|metres)$/i);
    if (mM) {
      fields.lengthM = Number(mM[1]);
      continue;
    }
    const mFt = token.match(/^([+-]?\d*\.?\d+)(ft|feet|foot)$/i);
    if (mFt) {
      fields.lengthM = Number(mFt[1]) * 0.3048;
      continue;
    }

    throw new ToolError(
      "bad-token",
      `Could not determine what "${token}" means.`,
      "Add a unit like A, V, m, or ft, use a wire size like 12awg or 4/0, or use key=value syntax such as current=20.",
    );
  }

  return fields;
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ToolError("impossible", `${name} must be a positive number, got ${value}.`, `Provide a positive value for ${name}.`);
  }
}

// ---------------------------------------------------------------------------
// Mode: lookup
// ---------------------------------------------------------------------------

function runLookup(raw: string): WireGaugeResult {
  const spec = parseSizeSpec(raw);
  const out: WireGaugeResult = {};
  let areaMm2: number;
  let n: number | undefined;

  if (spec.kind === "awg") {
    n = spec.n;
    areaMm2 = awgAreaMm2(n);
    out["Gauge"] = `${gaugeLabel(n)} AWG`;
  } else {
    areaMm2 = spec.mm2;
    out["Size"] = `${spec.mm2} mm2`;
    const nearestN = nearestAwgForArea(areaMm2);
    const closeToTen = areaMm2 > 2.3 && areaMm2 < 2.7;
    out["Nearest AWG"] = closeToTen
      ? `${gaugeLabel(nearestN)} AWG (commonly sold in the US as the equivalent of 14 AWG cordage, though ${gaugeLabel(nearestN)} AWG is numerically closer)`
      : `${gaugeLabel(nearestN)} AWG`;
  }

  const props = wireProps(areaMm2);
  out["Diameter"] = `${props.diameterMm.toFixed(3)} mm (${props.diameterIn.toFixed(4)} in)`;
  out["Area"] = `${areaMm2.toFixed(3)} mm2 (${Math.round(props.cmils)} cmil)`;
  out["Resistance (copper, 20C)"] = `${props.rCuPerKm.toFixed(3)} ohm/km`;
  out["Resistance (aluminum, 20C)"] = `${props.rAlPerKm.toFixed(3)} ohm/km`;

  if (spec.kind === "awg" && n !== undefined) {
    const necLabel = AWG_TO_NEC_LABEL[n];
    if (necLabel) {
      const nec = NEC_AMPACITY[necLabel];
      out["Ampacity, NEC 310.16 copper (60C / 75C / 90C)"] = `${nec.cu60} A / ${nec.cu75} A / ${nec.cu90} A`;
      if (nec.al75 !== undefined) out["Ampacity, NEC 310.16 aluminum (75C)"] = `${nec.al75} A`;
    } else {
      out["Ampacity, NEC 310.16"] = "Outside the common 14 AWG to 4/0 AWG reference range.";
    }
    const chassis = CHASSIS_TABLE[n];
    if (chassis) {
      out["Chassis wiring reference (hobbyist, not code)"] =
        `${chassis.chassisA} A open-air chassis wiring / ${chassis.powerA} A continuous power transmission`;
    }
    out["Nearest standard metric size"] = `${nearestMetricSize(areaMm2)} mm2`;
  } else {
    const nearestStdMetric = nearestMetricSize(areaMm2);
    const ampacity = METRIC_AMPACITY[nearestStdMetric];
    if (ampacity !== undefined) {
      out["Approximate ampacity (IEC-style reference)"] = `${ampacity} A near the ${nearestStdMetric} mm2 standard size`;
      out["Ampacity note"] =
        "Rough reference only, loosely based on IEC 60364-5-52 style two-cable free-air figures. Real ampacity depends heavily on installation method, grouping, and ambient temperature; check local code.";
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Mode: voltage-drop
// ---------------------------------------------------------------------------

function runVoltageDrop(raw: string): WireGaugeResult {
  const f = parseWireTokens(raw);
  const missing: string[] = [];
  if (f.current === undefined) missing.push("current (e.g. 20A)");
  if (f.lengthM === undefined) missing.push("length (e.g. 30m or 100ft)");
  if (f.gaugeAreaMm2 === undefined) missing.push("gauge (e.g. 12awg)");
  if (f.voltage === undefined) missing.push("voltage (e.g. 120V)");
  if (missing.length > 0) {
    throw new ToolError(
      "missing-values",
      `voltage-drop mode needs ${missing.join(", ")}.`,
      'Try "20A 30m 12awg 120V" or "current=20 length=30m gauge=12awg voltage=120".',
    );
  }

  const current = f.current as number;
  const lengthM = f.lengthM as number;
  const voltage = f.voltage as number;
  assertPositive("current", current);
  assertPositive("length", lengthM);
  assertPositive("voltage", voltage);

  const material = f.material ?? "copper";
  const phase = f.phase ?? "dc";
  const rho1000 = material === "copper" ? 17.24 : 26.5;
  const rPerKm = rho1000 / (f.gaugeAreaMm2 as number);
  const rPerM = rPerKm / 1000;

  const vdrop = phase === "ac3" ? Math.sqrt(3) * current * rPerM * lengthM : 2 * current * rPerM * lengthM;
  const pct = (vdrop / voltage) * 100;

  const verdict =
    pct <= 3
      ? "within the 3% branch-circuit guidance"
      : pct <= 5
        ? "exceeds the 3% branch-circuit guidance but within the 5% combined feeder-and-branch limit"
        : "exceeds both the 3% branch-circuit and 5% combined feeder-and-branch guidance";

  return {
    Wire: f.gaugeLabelText as string,
    Material: material,
    Circuit: phase === "ac3" ? "three-phase" : phase === "ac1" ? "single-phase AC" : "DC / single-phase",
    "Resistance used": `${rPerKm.toFixed(3)} ohm/km`,
    "Voltage drop": `${vdrop.toFixed(2)} V`,
    "Percent drop": `${pct.toFixed(2)}%`,
    Verdict: verdict,
    Formula: phase === "ac3" ? "Vdrop = sqrt(3) x I x R x L (one-way length)" : "Vdrop = 2 x I x R x L (round trip over one-way length)",
  };
}

// ---------------------------------------------------------------------------
// Mode: size-for
// ---------------------------------------------------------------------------

function runSizeFor(raw: string): WireGaugeResult {
  const f = parseWireTokens(raw);
  const missing: string[] = [];
  if (f.current === undefined) missing.push("current (e.g. 20A)");
  if (f.lengthM === undefined) missing.push("length (e.g. 30m or 100ft)");
  if (f.voltage === undefined) missing.push("voltage (e.g. 120V)");
  if (missing.length > 0) {
    throw new ToolError(
      "missing-values",
      `size-for mode needs ${missing.join(", ")}.`,
      'Try "20A 30m 120V" or "current=20 length=30m voltage=120 maxdrop=3".',
    );
  }

  const current = f.current as number;
  const lengthM = f.lengthM as number;
  const voltage = f.voltage as number;
  assertPositive("current", current);
  assertPositive("length", lengthM);
  assertPositive("voltage", voltage);

  const material = f.material ?? "copper";
  const phase = f.phase ?? "dc";
  const maxDropPct = f.maxDropPct ?? 3;
  const tempColumn = f.tempColumn ?? 75;

  const rho1000 = material === "copper" ? 17.24 : 26.5;
  const attempts: string[] = [];

  for (const { label, n } of NEC_ORDER) {
    const entry = NEC_AMPACITY[label];
    const ampacity = material === "copper" ? (tempColumn === 60 ? entry.cu60 : tempColumn === 90 ? entry.cu90 : entry.cu75) : entry.al75;

    const areaMm2 = awgAreaMm2(n);
    const rPerM = rho1000 / areaMm2 / 1000;
    const vdrop = phase === "ac3" ? Math.sqrt(3) * current * rPerM * lengthM : 2 * current * rPerM * lengthM;
    const pct = (vdrop / voltage) * 100;

    if (ampacity === undefined) {
      attempts.push(`${label} AWG: no ${material} ampacity data at this rating`);
      continue;
    }

    const ampacityPass = current <= ampacity;
    const dropPass = pct <= maxDropPct;
    if (ampacityPass && dropPass) {
      return {
        "Recommended gauge": `${label} AWG`,
        Material: material,
        Circuit: phase === "ac3" ? "three-phase" : phase === "ac1" ? "single-phase AC" : "DC / single-phase",
        "Ampacity constraint": `${current} A required, ${ampacity} A allowed at ${label} AWG (${material}, ${material === "copper" ? tempColumn : 75}C) -> pass`,
        "Voltage drop constraint": `${pct.toFixed(2)}% drop, ${maxDropPct}% limit -> pass`,
        "Voltage drop": `${vdrop.toFixed(2)} V`,
        Formula: phase === "ac3" ? "Vdrop = sqrt(3) x I x R x L" : "Vdrop = 2 x I x R x L",
      };
    }

    attempts.push(
      `${label} AWG: ampacity ${ampacityPass ? "pass" : `fail (${ampacity} A < ${current} A)`}, drop ${
        dropPass ? "pass" : `fail (${pct.toFixed(2)}% > ${maxDropPct}%)`
      }`,
    );
  }

  throw new ToolError(
    "impossible",
    `No gauge up to 4/0 AWG satisfies both the ampacity and ${maxDropPct}% voltage drop requirements for ${current}A over ${lengthM}m at ${voltage}V. Largest tried: ${attempts[attempts.length - 1]}.`,
    "Increase the wire size beyond 4/0 AWG, shorten the run, raise the supply voltage, or relax the drop limit.",
  );
}

// ---------------------------------------------------------------------------

export function run(input: string, opts: WireGaugeOpts): WireGaugeResult {
  const raw = (input ?? "").trim();
  if (!raw) {
    throw new ToolError(
      "empty-input",
      "Enter a wire size or calculation values.",
      'Try "12 awg", "20A 30m 12awg 120V", or "20A 30m 120V" depending on the mode.',
    );
  }

  const mode = opts.mode || "lookup";
  if (mode === "voltage-drop") return runVoltageDrop(raw);
  if (mode === "size-for") return runSizeFor(raw);
  return runLookup(raw);
}

export default { run } satisfies ToolLogic<string, WireGaugeResult, WireGaugeOpts>;

// Exported for tests only; not part of the tool's public logic surface.
export const __test__ = { diameterMm, awgAreaMm2, gaugeLabel, wireProps, nearestAwgForArea, parseSizeSpec };
