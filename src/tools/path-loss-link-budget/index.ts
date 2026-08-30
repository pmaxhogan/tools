import { ToolError, type ToolLogic } from "../types";

export interface PathLossOpts {
  /** Output distance unit label only, does not change parsing: "km" | "mi" | "m" | "ft" */
  distanceUnit: string;
  [key: string]: unknown;
}

export type PathLossResult = Record<string, string>;

const C = 299792458; // m/s, exact

const FREQ_SUFFIXES: { suf: string; mult: number }[] = [
  { suf: "ghz", mult: 1e9 },
  { suf: "mhz", mult: 1e6 },
  { suf: "khz", mult: 1e3 },
  { suf: "hz", mult: 1 },
];

const DIST_SUFFIXES: { suf: string; toM: number }[] = [
  { suf: "km", toM: 1000 },
  { suf: "mi", toM: 1609.344 },
  { suf: "ft", toM: 0.3048 },
  { suf: "m", toM: 1 },
];

function parseFrequencyHz(raw: string, tokenLabel = "frequency"): number {
  const s = (raw ?? "").trim();
  if (!s) {
    throw new ToolError(
      "bad-frequency",
      `Enter a ${tokenLabel}, like "915 MHz".`,
      'Try "915 MHz", "2.4GHz", or "5800000000" (Hz).',
    );
  }
  const compact = s.toLowerCase().replace(/\s+/g, "");
  for (const { suf, mult } of FREQ_SUFFIXES) {
    if (compact.endsWith(suf)) {
      const num = Number(compact.slice(0, -suf.length));
      if (!Number.isFinite(num)) {
        throw new ToolError(
          "bad-frequency",
          `Could not parse "${s}" as a frequency.`,
          "Use a number followed by Hz, kHz, MHz, or GHz.",
        );
      }
      return num * mult;
    }
  }
  const bare = Number(compact);
  if (!Number.isFinite(bare)) {
    throw new ToolError(
      "bad-frequency",
      `Could not parse "${s}" as a frequency.`,
      'Use a number followed by Hz, kHz, MHz, or GHz, like "915 MHz".',
    );
  }
  return bare * 1e6;
}

function parseDistanceM(raw: string): number {
  const s = (raw ?? "").trim();
  const compact = s.toLowerCase().replace(/\s+/g, "");
  for (const { suf, toM } of DIST_SUFFIXES) {
    if (compact.endsWith(suf)) {
      const num = Number(compact.slice(0, -suf.length));
      if (!Number.isFinite(num)) {
        throw new ToolError(
          "bad-distance",
          `Could not parse "${s}" as a distance.`,
          "Use a number followed by m, km, ft, or mi.",
        );
      }
      return num * toM;
    }
  }
  const bare = Number(compact);
  if (!Number.isFinite(bare)) {
    throw new ToolError(
      "bad-distance",
      `Could not parse "${s}" as a distance.`,
      'Use a number followed by m, km, ft, or mi, like "5 km".',
    );
  }
  return bare * 1000; // bare number assumed km, the common link-budget convention
}

/** dBm value in a plain number, e.g. "30" or "30dBm". */
function parseDbm(raw: string, label: string): number {
  const s = (raw ?? "").trim();
  const m = s.match(/^([+-]?\d*\.?\d+)\s*dbm$/i);
  if (m) return Number(m[1]);
  const w = s.match(/^([+-]?\d*\.?\d+)\s*w$/i);
  if (w) return 10 * Math.log10(Number(w[1]) * 1000);
  const num = Number(s);
  if (!Number.isFinite(num)) {
    throw new ToolError(
      "bad-power",
      `Could not parse ${label} "${s}".`,
      "Use a number in dBm, or a number followed by W for watts.",
    );
  }
  return num; // bare number assumed dBm
}

function parseDb(raw: string, label: string, fallback = 0): number {
  const s = (raw ?? "").trim();
  if (!s) return fallback;
  const num = Number(s.replace(/db i?$/i, "").trim());
  if (!Number.isFinite(num)) {
    throw new ToolError(
      "bad-value",
      `Could not parse ${label} "${s}" as dB.`,
      "Use a plain number of dB or dBi.",
    );
  }
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

/** Free space path loss in dB: FSPL = 20log10(d) + 20log10(f) + 20log10(4pi/c). */
function fsplDb(distanceM: number, freqHz: number): number {
  return 20 * Math.log10((4 * Math.PI * distanceM * freqHz) / C);
}

interface DistUnit {
  suf: string;
  toM: number;
}
const DISPLAY_UNITS: Record<string, DistUnit> = {
  km: { suf: "km", toM: 1000 },
  mi: { suf: "mi", toM: 1609.344 },
  m: { suf: "m", toM: 1 },
  ft: { suf: "ft", toM: 0.3048 },
};

function formatDistance(m: number, unit: DistUnit): string {
  const v = m / unit.toM;
  const decimals = v >= 100 ? 1 : v >= 1 ? 3 : 5;
  return `${v.toFixed(decimals)} ${unit.suf}`;
}

/** Joins a number and a unit word written as two tokens ("915 MHz" -> "915MHz") before tokenizing. */
const NUMBER_UNIT_JOIN = /(\d+(?:\.\d+)?)\s+(GHz|MHz|kHz|Hz|km|mi|ft|m)\b/gi;

/** Parse "freq=915MHz distance=5km txpower=30dBm ..." style input, plus bare frequency+distance tokens. */
function parseInput(raw: string): { freqHz: number; distM: number; extra: Record<string, string> } {
  const s = (raw ?? "").trim();
  if (!s) {
    throw new ToolError(
      "empty-input",
      'Enter a frequency and distance, like "915 MHz 5 km".',
      'Try "915 MHz 5km" or "freq=915MHz distance=5km txpower=20dBm txgain=6 rxgain=6 cableloss=1 sensitivity=-100dBm".',
    );
  }
  const tokens = s
    .replace(NUMBER_UNIT_JOIN, "$1$2")
    .split(/[\s,]+/)
    .filter(Boolean);
  let freqHz: number | undefined;
  let distM: number | undefined;
  const extra: Record<string, string> = {};

  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq > 0) {
      const key = token.slice(0, eq).toLowerCase();
      const val = token.slice(eq + 1);
      if (["freq", "frequency", "f"].includes(key)) {
        freqHz = parseFrequencyHz(val);
      } else if (["distance", "dist", "d", "range"].includes(key)) {
        distM = parseDistanceM(val);
      } else {
        extra[key] = val;
      }
      continue;
    }
    if (/^[\d.]+\s*(ghz|mhz|khz|hz)$/i.test(token) || /^[\d.]+(ghz|mhz|khz|hz)$/i.test(token)) {
      freqHz = parseFrequencyHz(token);
      continue;
    }
    if (/^[\d.]+(km|mi|ft|m)$/i.test(token)) {
      distM = parseDistanceM(token);
      continue;
    }
  }

  if (freqHz === undefined) {
    throw new ToolError(
      "missing-frequency",
      "No frequency found in the input.",
      'Add a frequency like "915 MHz" or "freq=915MHz".',
    );
  }
  if (distM === undefined) {
    throw new ToolError(
      "missing-distance",
      "No distance found in the input.",
      'Add a distance like "5 km" or "distance=5km".',
    );
  }
  return { freqHz, distM, extra };
}

export function run(input: string, opts: PathLossOpts): PathLossResult {
  const { freqHz, distM, extra } = parseInput(input);
  assertPositive("frequency", freqHz);
  assertPositive("distance", distM);

  const unit = DISPLAY_UNITS[opts.distanceUnit] ?? DISPLAY_UNITS.km;
  const freqMHz = freqHz / 1e6;
  const loss = fsplDb(distM, freqHz);

  const out: PathLossResult = {};
  out["Frequency"] = `${freqMHz.toFixed(4)} MHz`;
  out["Distance"] = formatDistance(distM, unit);
  out["Free space path loss"] = `${loss.toFixed(2)} dB`;
  out["FSPL at 1 km"] = `${fsplDb(1000, freqHz).toFixed(2)} dB`;
  out["FSPL at 10 km"] = `${fsplDb(10000, freqHz).toFixed(2)} dB`;
  out["Formula"] = "FSPL(dB) = 20 log10(d) + 20 log10(f) + 20 log10(4 pi / c)";
  out["Note"] =
    "Free space path loss assumes an unobstructed line of sight with no ground reflection, terrain, or foliage. Real links, especially near ground level, often see extra loss from the two ray ground reflection model described in ITU-R P.525; treat this figure as a best case.";

  const hasBudgetInputs = "txpower" in extra || "power" in extra || "sensitivity" in extra;
  if (!hasBudgetInputs) return out;

  const txPowerRaw = extra.txpower ?? extra.power;
  if (txPowerRaw === undefined) {
    throw new ToolError(
      "missing-values",
      "A link budget needs a transmit power (txpower) as well as a receiver sensitivity.",
      "Add txpower=20dBm and sensitivity=-100dBm to the input.",
    );
  }
  if (extra.sensitivity === undefined) {
    throw new ToolError(
      "missing-values",
      "A link budget needs a receiver sensitivity (sensitivity) as well as a transmit power.",
      "Add sensitivity=-100dBm to the input.",
    );
  }

  const txPowerDbm = parseDbm(txPowerRaw, "transmit power");
  const txGainDb = parseDb(extra.txgain ?? extra.tgain, "transmit antenna gain");
  const rxGainDb = parseDb(extra.rxgain ?? extra.rgain, "receive antenna gain");
  const cableLossDb = parseDb(extra.cableloss ?? extra.loss, "cable loss");
  const sensitivityDbm = parseDbm(extra.sensitivity, "receiver sensitivity");

  const eirpDbm = txPowerDbm + txGainDb - cableLossDb;
  const rxPowerDbm = eirpDbm - loss + rxGainDb;
  const fadeMarginDb = rxPowerDbm - sensitivityDbm;
  const passes = fadeMarginDb >= 0;

  out["TX power"] = `${txPowerDbm.toFixed(2)} dBm`;
  out["TX antenna gain"] = `${txGainDb.toFixed(2)} dBi`;
  out["Cable / feedline loss"] = `${cableLossDb.toFixed(2)} dB`;
  out["EIRP"] = `${eirpDbm.toFixed(2)} dBm`;
  out["RX antenna gain"] = `${rxGainDb.toFixed(2)} dBi`;
  out["Received power"] = `${rxPowerDbm.toFixed(2)} dBm`;
  out["Receiver sensitivity"] = `${sensitivityDbm.toFixed(2)} dBm`;
  out["Fade margin"] = `${fadeMarginDb.toFixed(2)} dB`;
  out["Link"] = passes
    ? `Passes: received power exceeds sensitivity by ${fadeMarginDb.toFixed(2)} dB.`
    : `Fails: received power is ${Math.abs(fadeMarginDb).toFixed(2)} dB below sensitivity.`;

  return out;
}

export default { run } satisfies ToolLogic<string, PathLossResult, PathLossOpts>;

// Exported for tests only; not part of the tool's public logic surface.
export const __test__ = { parseFrequencyHz, parseDistanceM, fsplDb, parseInput };
