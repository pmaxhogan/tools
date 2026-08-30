import { ToolError, type ToolLogic } from "../types";

export interface CoaxCableLossOpts {
  /** Cable type key, e.g. "rg8x", "lmr400". */
  cable: string;
  /** Compare every cable at once instead of just the selected one. */
  compareAll: boolean;
  [key: string]: unknown;
}

export type CoaxCableLossResult = Record<string, string>;

/**
 * Attenuation, dB per 100 ft, at the frequencies below (MHz). Every cable's
 * dB/100ft array was checked against its manufacturer datasheet (retrieved
 * 2026-08-30, see the `source` field on each entry below) and corrected where
 * it was off by more than about 10%. Datasheets that do not publish a point
 * above 1000 MHz (all of the RG-series cables here) are extended to 1500,
 * 2400, and 5800 MHz with a two-term skin-effect-plus-dielectric-loss model,
 * attenuation = A*sqrt(f) + B*f, fit by least squares to that manufacturer's
 * own published points; this is the same functional form Times Microwave
 * publishes for its own LMR cables. Everywhere else the table holds the
 * manufacturer's own published dB/100ft figures directly (interpolated
 * log-log between two published points where a target frequency fell between
 * them; see interpolateLoss). Interpolation between table points at runtime
 * is also log-log.
 */
const FREQS_MHZ = [30, 50, 150, 450, 900, 1500, 2400, 5800];

interface CableSpec {
  label: string;
  synonyms: string[];
  velocityFactor: number;
  /** dB per 100 ft at each frequency in FREQS_MHZ, same order. */
  dbPer100ft: number[];
  /** Manufacturer datasheet this cable's dB/100ft figures were verified against. */
  source: string;
}

const CABLES: Record<string, CableSpec> = {
  rg174: {
    label: "RG-174",
    synonyms: ["rg-174", "rg174u"],
    velocityFactor: 0.66,
    dbPer100ft: [4.85, 5.8, 10.6, 20.5, 31.0, 43.8, 60.2, 113.4],
    source:
      "Belden 8216 datasheet, https://catalog.belden.com/techdata/EN/8216_techdata.pdf (retrieved 2026-08-30). Published to 1000 MHz; 1500/2400/5800 MHz extrapolated (see file header).",
  },
  rg58: {
    label: "RG-58",
    synonyms: ["rg-58", "rg58u", "rg58au"],
    velocityFactor: 0.66,
    dbPer100ft: [2.78, 3.7, 6.85, 13.4, 21.1, 30.1, 42.3, 83.0],
    source:
      "Belden 8259 datasheet, https://catalog.belden.com/techdata/EN/8259_techdata.pdf (retrieved 2026-08-30). Published to 1000 MHz; 1500/2400/5800 MHz extrapolated (see file header).",
  },
  rg8x: {
    label: "RG-8X",
    synonyms: ["rg-8x", "mini8", "mini-8"],
    velocityFactor: 0.78,
    dbPer100ft: [1.61, 2.1, 3.86, 7.06, 10.7, 14.4, 19.4, 34.8],
    source:
      "Belden 9258 datasheet, https://catalog.belden.com/techdata/EN/9258_techdata.pdf (retrieved 2026-08-30). Published to 1000 MHz; 1500/2400/5800 MHz extrapolated (see file header).",
  },
  rg8: {
    label: "RG-8/213",
    synonyms: ["rg-8", "rg213", "rg-213", "rg8u"],
    velocityFactor: 0.66,
    dbPer100ft: [0.99, 1.3, 2.33, 4.52, 7.6, 10.7, 14.9, 28.7],
    source:
      "Belden 8267 datasheet (RG-213, mil-spec, non-QPL), https://catalog.belden.com/techdata/EN/8267_techdata.pdf (retrieved 2026-08-30). Published to 1000 MHz (plus a 4000 MHz point); 1500/2400/5800 MHz extrapolated (see file header). Belden's low-loss foam-dielectric 9913 (a distinct 'RG-8 type' product, not shown here) runs meaningfully lower loss, about 4.1 dB/100ft at 900 MHz versus 7.6 for mil-spec RG-213.",
  },
  rg6: {
    label: "RG-6",
    synonyms: ["rg-6", "rg6u", "cable tv coax"],
    velocityFactor: 0.85,
    dbPer100ft: [1.17, 1.45, 2.35, 4.12, 5.95, 7.8, 10.2, 17.3],
    source:
      "Belden 1694A datasheet, https://catalog.belden.com/techdata/EN/1694A_techdata.pdf (retrieved 2026-08-30). Published points run to 6000 MHz, so every table value here is directly interpolated, not extrapolated.",
  },
  rg59: {
    label: "RG-59",
    synonyms: ["rg-59", "rg59u"],
    velocityFactor: 0.78,
    dbPer100ft: [1.61, 2.1, 3.8, 7.03, 10.1, 13.7, 18.2, 31.5],
    source:
      "Belden 9259 datasheet, https://catalog.belden.com/techdata/EN/9259_techdata.pdf (retrieved 2026-08-30). Published to 1000 MHz; 1500/2400/5800 MHz extrapolated (see file header).",
  },
  lmr195: {
    label: "LMR-195",
    synonyms: ["lmr-195", "times microwave 195"],
    velocityFactor: 0.83,
    dbPer100ft: [2.0, 2.5, 4.4, 7.8, 11.1, 14.5, 18.6, 29.9],
    source:
      "Times Microwave LMR-195 datasheet (retrieved 2026-08-30), reproduced at https://www.rfparts.com/fileuploader/download/download/?d=0&file=custom/upload/File-1447884279.pdf. Published table runs 30-5800 MHz; every value here is directly interpolated, not extrapolated.",
  },
  lmr240: {
    label: "LMR-240",
    synonyms: ["lmr-240", "times microwave 240"],
    velocityFactor: 0.84,
    dbPer100ft: [1.3, 1.7, 3.0, 5.3, 7.6, 9.9, 12.6, 20.4],
    source:
      "Times Microwave LMR-240 datasheet (retrieved 2026-08-30), reproduced at https://www.talleycom.com/images/pdf/TIMLMR-240.pdf. Published table runs 30-5800 MHz; every value here is directly interpolated, not extrapolated.",
  },
  lmr400: {
    label: "LMR-400",
    synonyms: ["lmr-400", "times microwave 400"],
    velocityFactor: 0.85,
    dbPer100ft: [0.7, 0.9, 1.5, 2.7, 3.9, 5.1, 6.6, 10.8],
    source:
      "Times Microwave LMR-400 datasheet (retrieved 2026-08-30), reproduced at https://www.gpsnetworking.com/system/datasheets/132/original/LMR400A.pdf. Published table runs 30-5800 MHz; every value here is directly interpolated, not extrapolated.",
  },
  lmr600: {
    label: "LMR-600",
    synonyms: ["lmr-600", "times microwave 600"],
    velocityFactor: 0.87,
    dbPer100ft: [0.4, 0.5, 1.0, 1.7, 2.5, 3.3, 4.3, 7.3],
    source:
      "Times Microwave LMR-600 (standard, not UltraFlex) datasheet (retrieved 2026-08-30), reproduced at https://www.talleycom.com/images/pdf/TIMLMR600.pdf. Published table runs 30-5800 MHz; every value here is directly interpolated, not extrapolated.",
  },
  heliax12: {
    label: "Heliax 1/2 in (LDF4-50A)",
    synonyms: ["heliax", "ldf4-50a", "1/2 inch heliax", "andrew heliax"],
    velocityFactor: 0.88,
    dbPer100ft: [0.36, 0.46, 0.82, 1.45, 2.1, 2.77, 3.6, 5.99],
    source:
      "CommScope/Andrew HELIAX LDF4-50A product specification, https://www.repeater-builder.com/antenna/andrew/andrew-ldf4-50a-spec-sheet.pdf (retrieved 2026-08-30). Published table runs 0.5-8800 MHz; every value here is directly interpolated, not extrapolated.",
  },
};

const DIST_SUFFIXES: { suf: string; toM: number }[] = [
  { suf: "km", toM: 1000 },
  { suf: "mi", toM: 1609.344 },
  { suf: "ft", toM: 0.3048 },
  { suf: "m", toM: 1 },
];

const FREQ_SUFFIXES: { suf: string; mult: number }[] = [
  { suf: "ghz", mult: 1e9 },
  { suf: "mhz", mult: 1e6 },
  { suf: "khz", mult: 1e3 },
  { suf: "hz", mult: 1 },
];

const NUMBER_UNIT_JOIN = /(\d+(?:\.\d+)?)\s+(GHz|MHz|kHz|Hz|km|mi|ft|m|W|dBm)\b/gi;

function parseFrequencyHz(raw: string): number {
  const compact = raw.toLowerCase().replace(/\s+/g, "");
  for (const { suf, mult } of FREQ_SUFFIXES) {
    if (compact.endsWith(suf)) {
      const num = Number(compact.slice(0, -suf.length));
      if (!Number.isFinite(num)) {
        throw new ToolError(
          "bad-frequency",
          `Could not parse "${raw}" as a frequency.`,
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
      `Could not parse "${raw}" as a frequency.`,
      'Use a number followed by Hz, kHz, MHz, or GHz, like "446MHz".',
    );
  }
  return bare * 1e6;
}

function parseDistanceM(raw: string, label = "length"): number {
  const compact = raw.toLowerCase().replace(/\s+/g, "");
  for (const { suf, toM } of DIST_SUFFIXES) {
    if (compact.endsWith(suf)) {
      const num = Number(compact.slice(0, -suf.length));
      if (!Number.isFinite(num)) {
        throw new ToolError(
          "bad-distance",
          `Could not parse "${raw}" as a ${label}.`,
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
      `Could not parse "${raw}" as a ${label}.`,
      `Use a number followed by m, km, ft, or mi, like "30m" or "100ft".`,
    );
  }
  return bare;
}

/**
 * Log-log interpolation of the attenuation table: both dB/100ft and MHz are
 * treated on log scales, which tracks the real skin-effect-dominated
 * attenuation curve far better than linear interpolation. Frequencies below
 * the table's lowest point or above its highest point are extrapolated using
 * the nearest two known points on the same log-log line.
 */
function interpolateLoss(spec: CableSpec, freqMHz: number): number {
  const xs = FREQS_MHZ.map((f) => Math.log10(f));
  const ys = spec.dbPer100ft.map((d) => Math.log10(d));
  const x = Math.log10(freqMHz);

  let i = 0;
  if (x <= xs[0]) i = 0;
  else if (x >= xs[xs.length - 1]) i = xs.length - 2;
  else {
    while (i < xs.length - 2 && xs[i + 1] < x) i++;
  }

  const x0 = xs[i];
  const x1 = xs[i + 1];
  const y0 = ys[i];
  const y1 = ys[i + 1];
  const t = (x - x0) / (x1 - x0);
  const y = y0 + t * (y1 - y0);
  return Math.pow(10, y);
}

function resolveCable(key: string): CableSpec {
  const spec = CABLES[key];
  if (!spec) {
    throw new ToolError(
      "unknown-cable",
      `Unknown cable type "${key}".`,
      "Choose one of the cable types from the dropdown, such as RG-58, RG-8X, LMR-400, or Heliax 1/2 inch.",
    );
  }
  return spec;
}

interface Fields {
  freqHz?: number;
  lengthM?: number;
  inputPowerW?: number;
}

function parseInput(raw: string): Fields {
  const s = (raw ?? "").trim();
  if (!s) {
    throw new ToolError(
      "empty-input",
      'Enter a length and a frequency, like "100ft 446MHz".',
      'Try "100ft 446MHz" or "length=30m freq=915MHz power=5W".',
    );
  }
  const tokens = s
    .replace(NUMBER_UNIT_JOIN, "$1$2")
    .split(/[\s,]+/)
    .filter(Boolean);
  const fields: Fields = {};

  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq > 0) {
      const key = token.slice(0, eq).toLowerCase();
      const val = token.slice(eq + 1);
      if (["freq", "frequency", "f"].includes(key)) fields.freqHz = parseFrequencyHz(val);
      else if (["length", "len", "l", "distance"].includes(key))
        fields.lengthM = parseDistanceM(val);
      else if (["power", "p", "txpower"].includes(key)) {
        const wMatch = val.match(/^([\d.]+)w$/i);
        const dbmMatch = val.match(/^([\d.+-]+)dbm$/i);
        if (wMatch) fields.inputPowerW = Number(wMatch[1]);
        else if (dbmMatch) fields.inputPowerW = Math.pow(10, (Number(dbmMatch[1]) - 30) / 10);
        else {
          throw new ToolError(
            "bad-power",
            `Could not parse power "${val}".`,
            "Use a number followed by W or dBm, like 5W or 37dBm.",
          );
        }
      } else {
        throw new ToolError(
          "bad-token",
          `Unrecognized key "${key}" in "${token}".`,
          "Use freq, length, or power.",
        );
      }
      continue;
    }
    if (/^[\d.]+(ghz|mhz|khz|hz)$/i.test(token) && fields.freqHz === undefined) {
      fields.freqHz = parseFrequencyHz(token);
      continue;
    }
    if (/^[\d.]+(km|mi|ft|m)$/i.test(token) && fields.lengthM === undefined) {
      fields.lengthM = parseDistanceM(token);
      continue;
    }
    if (/^[\d.]+w$/i.test(token) && fields.inputPowerW === undefined) {
      fields.inputPowerW = Number(token.slice(0, -1));
      continue;
    }
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

function computeForCable(
  spec: CableSpec,
  freqMHz: number,
  lengthFt: number,
  inputPowerW: number | undefined,
) {
  const dbPer100ft = interpolateLoss(spec, freqMHz);
  const lossDb = (dbPer100ft * lengthFt) / 100;
  const fractionRemaining = Math.pow(10, -lossDb / 10);
  const percentLost = (1 - fractionRemaining) * 100;
  let outputPowerW: number | undefined;
  if (inputPowerW !== undefined) outputPowerW = inputPowerW * fractionRemaining;
  return { dbPer100ft, lossDb, percentLost, outputPowerW };
}

export function run(input: string, opts: CoaxCableLossOpts): CoaxCableLossResult {
  const fields = parseInput(input);
  if (fields.freqHz === undefined) {
    throw new ToolError(
      "missing-frequency",
      "No frequency found in the input.",
      'Add a frequency like "446MHz" or "freq=446MHz".',
    );
  }
  if (fields.lengthM === undefined) {
    throw new ToolError(
      "missing-length",
      "No cable length found in the input.",
      'Add a length like "100ft" or "length=30m".',
    );
  }
  assertPositive("frequency", fields.freqHz);
  assertPositive("length", fields.lengthM);

  const freqMHz = fields.freqHz / 1e6;
  const lengthFt = fields.lengthM / 0.3048;
  const inputPowerW = fields.inputPowerW;
  if (inputPowerW !== undefined) assertPositive("power", inputPowerW);

  const out: CoaxCableLossResult = {};
  out["Frequency"] = `${freqMHz.toFixed(3)} MHz`;
  out["Length"] = `${fields.lengthM.toFixed(2)} m (${lengthFt.toFixed(1)} ft)`;

  if (opts.compareAll) {
    const rows = Object.values(CABLES)
      .map((spec) => {
        const r = computeForCable(spec, freqMHz, lengthFt, inputPowerW);
        return { spec, r };
      })
      .sort((a, b) => a.r.lossDb - b.r.lossDb);
    for (const { spec, r } of rows) {
      const powerPart =
        r.outputPowerW !== undefined
          ? `, ${r.outputPowerW.toFixed(3)} W delivered (${r.percentLost.toFixed(1)}% lost)`
          : "";
      out[spec.label] =
        `${r.lossDb.toFixed(2)} dB total (${r.dbPer100ft.toFixed(2)} dB/100ft)${powerPart}`;
    }
    out["Note"] =
      "Sorted from lowest to highest loss for this length and frequency. Attenuation figures are log-log interpolated from published manufacturer spec sheets and assume a well matched 50 ohm load; a mismatched load adds extra loss beyond these numbers.";
    return out;
  }

  const spec = resolveCable(opts.cable || "rg8x");
  const r = computeForCable(spec, freqMHz, lengthFt, inputPowerW);

  out["Cable"] = spec.label;
  out["Velocity factor"] = String(spec.velocityFactor);
  out["Attenuation at this frequency"] = `${r.dbPer100ft.toFixed(3)} dB / 100 ft`;
  out["Total loss over this length"] = `${r.lossDb.toFixed(2)} dB`;
  out["Percent of power lost"] = `${r.percentLost.toFixed(2)}%`;
  out["Percent of power delivered"] = `${(100 - r.percentLost).toFixed(2)}%`;
  if (inputPowerW !== undefined && r.outputPowerW !== undefined) {
    out["Input power"] = `${inputPowerW.toFixed(3)} W`;
    out["Power delivered to the load"] = `${r.outputPowerW.toFixed(3)} W`;
    out["Power lost in the cable"] = `${(inputPowerW - r.outputPowerW).toFixed(3)} W`;
  }
  out["Note"] =
    "Attenuation is log-log interpolated between the published manufacturer spec sheet points and assumes a well matched 50 ohm load (75 ohm for RG-6/RG-59); a mismatched load adds extra loss beyond these numbers, growing with both VSWR and cable length.";

  return out;
}

export default { run } satisfies ToolLogic<string, CoaxCableLossResult, CoaxCableLossOpts>;

// Exported for tests only; not part of the tool's public logic surface.
export const __test__ = {
  CABLES,
  interpolateLoss,
  parseFrequencyHz,
  parseDistanceM,
  parseInput,
  resolveCable,
};
