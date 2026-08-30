import { ToolError, type ToolLogic } from "../types";

export interface AntennaLengthOpts {
  /** "full-wave" | "half-wave-dipole" | "quarter-wave-vertical" | "five-eighth-wave" | "yagi-3-element" */
  mode: string;
  /** "wire" | "tubing" */
  conductor: string;
  /** 0 disables the override and falls back to the conductor preset. */
  customVf: number;
  [key: string]: unknown;
}

export type AntennaLengthResult = Record<string, string>;

/** Speed of light, exact SI value, m/s. */
const C = 299792458;

const FREQ_SUFFIXES: { suf: string; mult: number }[] = [
  { suf: "ghz", mult: 1e9 },
  { suf: "mhz", mult: 1e6 },
  { suf: "khz", mult: 1e3 },
  { suf: "hz", mult: 1 },
];

/** Parse "146.52 MHz", "7.1MHz", "2.45GHz", or a bare number (read as MHz). */
function parseFrequencyHz(raw: string): number {
  const s = (raw ?? "").trim();
  if (!s) {
    throw new ToolError(
      "empty-input",
      'Enter a frequency, like "146.52 MHz".',
      'Try "146.52 MHz", "7.1MHz", "2.45GHz", or "146520000" (Hz).',
    );
  }
  const compact = s.toLowerCase().replace(/\s+/g, "");
  for (const { suf, mult } of FREQ_SUFFIXES) {
    if (compact.endsWith(suf)) {
      const numPart = compact.slice(0, -suf.length);
      const num = Number(numPart);
      if (numPart === "" || !Number.isFinite(num)) {
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
      'Use a number followed by Hz, kHz, MHz, or GHz, like "146.52 MHz". A bare number is read as MHz.',
    );
  }
  return bare * 1e6;
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

/** "1.944 m (194.4 cm) = 6 ft 4.55 in (6.379 ft)" */
function formatLength(m: number): string {
  const ft = m / 0.3048;
  const wholeFt = Math.floor(ft);
  const inches = (ft - wholeFt) * 12;
  const cm = m * 100;
  return `${m.toFixed(3)} m (${cm.toFixed(1)} cm) = ${wholeFt} ft ${inches.toFixed(2)} in (${ft.toFixed(3)} ft)`;
}

function resolveVf(opts: AntennaLengthOpts): { vf: number; label: string } {
  const custom = typeof opts.customVf === "number" ? opts.customVf : 0;
  if (custom > 0) {
    if (custom > 1) {
      throw new ToolError(
        "impossible",
        `Velocity factor must be between 0 and 1, got ${custom}.`,
        "Use a value like 0.95 for wire or 0.98 for tubing, or 0 to use the conductor preset.",
      );
    }
    return { vf: custom, label: `custom (${custom})` };
  }
  const conductor = opts.conductor === "tubing" ? "tubing" : "wire";
  return conductor === "tubing"
    ? { vf: 0.98, label: "tubing (0.98)" }
    : { vf: 0.95, label: "wire (0.95)" };
}

export function run(input: string, opts: AntennaLengthOpts): AntennaLengthResult {
  const freqHz = parseFrequencyHz(input);
  assertPositive("frequency", freqHz);
  const freqMHz = freqHz / 1e6;

  const { vf, label } = resolveVf(opts);
  const freeSpaceWavelengthM = C / freqHz;
  const fullWaveM = freeSpaceWavelengthM * vf;
  const halfWaveM = fullWaveM / 2;
  const quarterWaveM = fullWaveM / 4;
  const fiveEighthWaveM = (fullWaveM * 5) / 8;

  const mode = opts.mode || "half-wave-dipole";
  const out: AntennaLengthResult = {};
  out["Frequency"] = `${freqMHz.toFixed(4)} MHz`;
  out["Velocity factor used"] = label;
  out["Free space wavelength"] = formatLength(freeSpaceWavelengthM);

  if (mode === "full-wave") {
    out["Full wave length"] = formatLength(fullWaveM);
    out["Formula"] = "L = c / f x velocity factor";
  } else if (mode === "quarter-wave-vertical") {
    out["Quarter wave length"] = formatLength(quarterWaveM);
    out["Classic formula (234 / f, feet, MHz)"] = `${(234 / freqMHz).toFixed(3)} ft`;
    out["Formula"] = "L = (c / f x velocity factor) / 4";
  } else if (mode === "five-eighth-wave") {
    out["5/8 wave length"] = formatLength(fiveEighthWaveM);
    out["Formula"] = "L = (c / f x velocity factor) x 5/8";
    out["Note"] =
      "A practical 5/8 wave vertical usually needs a loading coil to bring the feedpoint reactance back to resonance. This is the raw physical length, not the electrical length with matching.";
  } else if (mode === "yagi-3-element") {
    const drivenLen = halfWaveM;
    const reflectorLen = drivenLen * 1.05;
    const directorLen = drivenLen * 0.95;
    const reflectorSpacing = fullWaveM * 0.2;
    const directorSpacing = fullWaveM * 0.2;
    out["Driven element (half-wave dipole)"] = formatLength(drivenLen);
    out["Reflector (about 5% longer than driven)"] = formatLength(reflectorLen);
    out["Director (about 5% shorter than driven)"] = formatLength(directorLen);
    out["Reflector to driven spacing"] = formatLength(reflectorSpacing);
    out["Driven to director spacing"] = formatLength(directorSpacing);
    out["Total boom length"] = formatLength(reflectorSpacing + directorSpacing);
    out["Note"] =
      "Starter dimensions only, using common rule of thumb ratios (reflector 5% longer, director 5% shorter, 0.2 wavelength spacing). Real Yagi designs are optimized with modeling software for gain, front to back ratio, and feedpoint impedance.";
  } else {
    out["Half wave dipole length"] = formatLength(halfWaveM);
    out["Per leg length"] = formatLength(halfWaveM / 2);
    out["Classic formula (468 / f, feet, MHz)"] = `${(468 / freqMHz).toFixed(3)} ft`;
    out["Classic formula (143 / f, meters, MHz)"] = `${(143 / freqMHz).toFixed(3)} m`;
    out["Formula"] = "L = (c / f x velocity factor) / 2";
  }

  return out;
}

export default { run } satisfies ToolLogic<string, AntennaLengthResult, AntennaLengthOpts>;

// Exported for tests only; not part of the tool's public logic surface.
export const __test__ = { parseFrequencyHz, formatLength, resolveVf };
