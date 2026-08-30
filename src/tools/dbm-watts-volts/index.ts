import { ToolError, type ToolLogic } from "../types";

export interface DbmWattsVoltsOpts {
  /** Reference impedance in ohms for the volt conversions: 50, 75, or 600. */
  impedance: string;
  [key: string]: unknown;
}

export type DbmWattsVoltsResult = Record<string, string>;

/** Recognized unit suffixes for the input value, longest first so "dbuv" beats "uv". */
const UNIT_SUFFIXES: { suf: string; kind: "dbm" | "dbw" | "w" | "dbuv" | "v" }[] = [
  { suf: "dbuv", kind: "dbuv" },
  { suf: "dbm", kind: "dbm" },
  { suf: "dbw", kind: "dbw" },
  { suf: "vrms", kind: "v" },
  { suf: "vpp", kind: "v" },
  { suf: "w", kind: "w" },
  { suf: "v", kind: "v" },
];

const SI_PREFIXES: Record<string, number> = {
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  µ: 1e-6,
  m: 1e-3,
  k: 1e3,
  M: 1e6,
  G: 1e9,
};

interface Parsed {
  value: number;
  kind: "dbm" | "dbw" | "w" | "dbuv" | "v";
  isPeakToPeak: boolean;
}

/** Parse a value like "30dBm", "1W", "2mW", "10Vpp", "0.1Vrms", "120dBuV". */
function parseValue(raw: string): Parsed {
  const s = (raw ?? "").trim();
  if (!s) {
    throw new ToolError(
      "empty-input",
      'Enter a value to convert, like "30 dBm" or "1 W".',
      'Try "30dBm", "1W", "2mW", "0.1Vrms", "10Vpp", or "120dBuV".',
    );
  }
  const compact = s.replace(/\s+/g, "");
  const lower = compact.toLowerCase();
  const isPeakToPeak = lower.endsWith("vpp");

  for (const { suf, kind } of UNIT_SUFFIXES) {
    if (lower.endsWith(suf)) {
      const numAndPrefix = compact.slice(0, compact.length - suf.length);
      if (numAndPrefix === "") {
        throw new ToolError(
          "bad-value",
          `Could not parse "${s}": no number before the unit.`,
          "Use a number followed by a unit, like 30dBm.",
        );
      }
      let mult = 1;
      let numPart = numAndPrefix;
      const isDbUnit = kind === "dbm" || kind === "dbw" || kind === "dbuv";
      if (!isDbUnit) {
        const lastChar = numAndPrefix.slice(-1);
        if (lastChar in SI_PREFIXES) {
          mult = SI_PREFIXES[lastChar];
          numPart = numAndPrefix.slice(0, -1);
        }
      }
      const num = Number(numPart);
      if (!Number.isFinite(num)) {
        throw new ToolError(
          "bad-value",
          `Could not parse "${s}" as a number.`,
          "Use a plain number, optionally with an SI prefix like m, u, k, or M.",
        );
      }
      return { value: num * mult, kind, isPeakToPeak };
    }
  }

  throw new ToolError(
    "bad-unit",
    `Could not recognize a unit in "${s}".`,
    "Use dBm, dBW, W, mW, uW, Vrms, Vpp, or dBuV, for example 30dBm or 0.1Vrms.",
  );
}

const IMPEDANCE_OPTS: Record<string, number> = { "50": 50, "75": 75, "600": 600 };

function resolveImpedance(opts: DbmWattsVoltsOpts): number {
  return IMPEDANCE_OPTS[opts.impedance] ?? 50;
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new ToolError("impossible", `${name} is not a finite value.`, "Check the input value.");
  }
}

/** dBuV reference: 1 uV = 0 dBuV, so dBuV = 20*log10(Vrms / 1e-6). */
function dbuVFromVrms(vrms: number): number {
  return 20 * Math.log10(vrms / 1e-6);
}
function vrmsFromDbuV(dbuv: number): number {
  return 1e-6 * Math.pow(10, dbuv / 20);
}

function formatEng(value: number, unit: string): string {
  if (!Number.isFinite(value)) return `${value} ${unit}`;
  if (value === 0) return `0 ${unit}`;
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const scales = [
    { exp: -12, suf: "p" },
    { exp: -9, suf: "n" },
    { exp: -6, suf: "u" },
    { exp: -3, suf: "m" },
    { exp: 0, suf: "" },
    { exp: 3, suf: "k" },
    { exp: 6, suf: "M" },
    { exp: 9, suf: "G" },
  ];
  let choice = scales[scales.length - 1];
  let found = false;
  for (const sc of scales) {
    const scaled = abs / 10 ** sc.exp;
    if (scaled >= 1 && scaled < 1000) {
      choice = sc;
      found = true;
      break;
    }
  }
  if (!found && abs < 10 ** scales[0].exp) choice = scales[0];
  const scaled = abs / 10 ** choice.exp;
  const decimals = scaled < 10 ? 3 : scaled < 100 ? 2 : 1;
  return `${sign}${scaled.toFixed(decimals)} ${choice.suf}${unit}`;
}

function referenceTable(impedance: number): string {
  const rows = [0, 10, 20, 23, 27, 30, 37, 40, 43, 47, 50];
  return rows
    .map((dbm) => {
      const w = Math.pow(10, (dbm - 30) / 10);
      const vrms = Math.sqrt(w * impedance);
      return `${dbm} dBm = ${formatEng(w, "W")} = ${formatEng(vrms, "Vrms")} @ ${impedance} ohm`;
    })
    .join(" | ");
}

export function run(input: string, opts: DbmWattsVoltsOpts): DbmWattsVoltsResult {
  const parsed = parseValue(input);
  const impedance = resolveImpedance(opts);

  let watts: number;
  let vrms: number;

  if (parsed.kind === "dbm") {
    watts = Math.pow(10, (parsed.value - 30) / 10);
    vrms = Math.sqrt(watts * impedance);
  } else if (parsed.kind === "dbw") {
    watts = Math.pow(10, parsed.value / 10);
    vrms = Math.sqrt(watts * impedance);
  } else if (parsed.kind === "w") {
    if (parsed.value <= 0) {
      throw new ToolError(
        "impossible",
        `Power must be greater than 0, got ${parsed.value} W.`,
        "Enter a positive power in watts.",
      );
    }
    watts = parsed.value;
    vrms = Math.sqrt(watts * impedance);
  } else if (parsed.kind === "dbuv") {
    vrms = vrmsFromDbuV(parsed.value);
    watts = (vrms * vrms) / impedance;
  } else {
    // v (Vrms or Vpp)
    if (parsed.value <= 0) {
      throw new ToolError(
        "impossible",
        `Voltage must be greater than 0, got ${parsed.value} V.`,
        "Enter a positive voltage.",
      );
    }
    vrms = parsed.isPeakToPeak ? parsed.value / (2 * Math.SQRT2) : parsed.value;
    watts = (vrms * vrms) / impedance;
  }

  assertFinite("Power", watts);
  if (watts <= 0) {
    throw new ToolError(
      "impossible",
      "The converted power works out to zero or negative, which is not a valid signal level.",
      "Check the input value and sign.",
    );
  }

  const dbm = 10 * Math.log10(watts) + 30;
  const dbw = 10 * Math.log10(watts);
  const vpp = vrms * 2 * Math.SQRT2;
  const dbuv = dbuVFromVrms(vrms);

  const out: DbmWattsVoltsResult = {};
  out["dBm"] = `${dbm.toFixed(3)} dBm`;
  out["dBW"] = `${dbw.toFixed(3)} dBW`;
  out["Power"] = formatEng(watts, "W");
  out["Vrms"] = `${formatEng(vrms, "V")} (at ${impedance} ohm)`;
  out["Vpp"] = `${formatEng(vpp, "V")} (at ${impedance} ohm, sine wave)`;
  out["dBuV"] = `${dbuv.toFixed(2)} dBuV`;
  out["Reference impedance"] = `${impedance} ohm`;
  out["Reference table"] = referenceTable(impedance);

  return out;
}

export default { run } satisfies ToolLogic<string, DbmWattsVoltsResult, DbmWattsVoltsOpts>;

// Exported for tests only; not part of the tool's public logic surface.
export const __test__ = { parseValue, formatEng, dbuVFromVrms, vrmsFromDbuV };
