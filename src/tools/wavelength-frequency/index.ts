import { ToolError, type ToolLogic } from "../types";

export interface WavelengthFrequencyOpts {
  /** Velocity factor of the medium; 1 is free space / vacuum. */
  velocityFactor: number;
  [key: string]: unknown;
}

export type WavelengthFrequencyResult = Record<string, string>;

/** Speed of light, exact SI value, m/s. */
const C = 299792458;
/** Planck constant, exact SI value, J.s. */
const PLANCK = 6.62607015e-34;
/** Elementary charge, exact SI value, C. */
const ELEMENTARY_CHARGE = 1.602176634e-19;

const FREQ_SUFFIXES: { suf: string; mult: number }[] = [
  { suf: "thz", mult: 1e12 },
  { suf: "ghz", mult: 1e9 },
  { suf: "mhz", mult: 1e6 },
  { suf: "khz", mult: 1e3 },
  { suf: "hz", mult: 1 },
];

const LEN_SUFFIXES: { suf: string; toM: number }[] = [
  { suf: "km", toM: 1e3 },
  { suf: "nm", toM: 1e-9 },
  { suf: "um", toM: 1e-6 },
  { suf: "µm", toM: 1e-6 },
  { suf: "mm", toM: 1e-3 },
  { suf: "cm", toM: 1e-2 },
  { suf: "m", toM: 1 },
];

interface ItuBand {
  name: string;
  commonName?: string;
  lowHz: number;
  highHz: number;
}

/** ITU radio band designations, ELF through THF, plus a couple of well known common names for context. */
const ITU_BANDS: ItuBand[] = [
  { name: "ELF (Extremely Low Frequency)", lowHz: 3, highHz: 30 },
  { name: "SLF (Super Low Frequency)", lowHz: 30, highHz: 300 },
  { name: "ULF (Ultra Low Frequency)", lowHz: 300, highHz: 3e3 },
  { name: "VLF (Very Low Frequency)", lowHz: 3e3, highHz: 30e3 },
  { name: "LF (Low Frequency)", commonName: "longwave", lowHz: 30e3, highHz: 300e3 },
  { name: "MF (Medium Frequency)", commonName: "AM broadcast band", lowHz: 300e3, highHz: 3e6 },
  { name: "HF (High Frequency)", commonName: "shortwave", lowHz: 3e6, highHz: 30e6 },
  {
    name: "VHF (Very High Frequency)",
    commonName: "FM broadcast, air band",
    lowHz: 30e6,
    highHz: 300e6,
  },
  {
    name: "UHF (Ultra High Frequency)",
    commonName: "TV, Wi-Fi 2.4GHz, cellular",
    lowHz: 300e6,
    highHz: 3e9,
  },
  {
    name: "SHF (Super High Frequency)",
    commonName: "microwave, Wi-Fi 5GHz, satellite",
    lowHz: 3e9,
    highHz: 30e9,
  },
  {
    name: "EHF (Extremely High Frequency)",
    commonName: "millimeter wave, 5G FR2",
    lowHz: 30e9,
    highHz: 300e9,
  },
  {
    name: "THF (Tremendously High Frequency)",
    commonName: "submillimeter, terahertz",
    lowHz: 300e9,
    highHz: 3e12,
  },
];

function bandForFrequency(freqHz: number): ItuBand | null {
  for (const band of ITU_BANDS) {
    if (freqHz >= band.lowHz && freqHz < band.highHz) return band;
  }
  if (freqHz >= 3e12) return null; // above THF: infrared, visible light, and beyond, not an ITU radio band
  return null;
}

function parseFrequencyHz(raw: string): number {
  const compact = raw.toLowerCase().replace(/\s+/g, "");
  for (const { suf, mult } of FREQ_SUFFIXES) {
    if (compact.endsWith(suf)) {
      const num = Number(compact.slice(0, -suf.length));
      if (!Number.isFinite(num)) {
        throw new ToolError(
          "bad-frequency",
          `Could not parse "${raw}" as a frequency.`,
          "Use a number followed by Hz, kHz, MHz, GHz, or THz.",
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
      'Use a number followed by Hz, kHz, MHz, GHz, or THz, like "2.4GHz".',
    );
  }
  return bare * 1e6;
}

function parseWavelengthM(raw: string): number {
  const compact = raw.toLowerCase().replace(/\s+/g, "");
  for (const { suf, toM } of LEN_SUFFIXES) {
    if (compact.endsWith(suf)) {
      const num = Number(compact.slice(0, -suf.length));
      if (!Number.isFinite(num)) {
        throw new ToolError(
          "bad-wavelength",
          `Could not parse "${raw}" as a wavelength.`,
          "Use a number followed by nm, um, mm, cm, m, or km.",
        );
      }
      return num * toM;
    }
  }
  const bare = Number(compact);
  if (!Number.isFinite(bare)) {
    throw new ToolError(
      "bad-wavelength",
      `Could not parse "${raw}" as a wavelength.`,
      'Use a number followed by nm, um, mm, cm, m, or km, like "550nm" or "21cm".',
    );
  }
  return bare;
}

function formatFreq(hz: number): string {
  const scales = [
    { exp: 12, suf: "THz" },
    { exp: 9, suf: "GHz" },
    { exp: 6, suf: "MHz" },
    { exp: 3, suf: "kHz" },
    { exp: 0, suf: "Hz" },
  ];
  const abs = Math.abs(hz);
  for (const s of scales) {
    const scaled = abs / 10 ** s.exp;
    if (scaled >= 1)
      return `${(hz / 10 ** s.exp).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")} ${s.suf}`;
  }
  return `${hz} Hz`;
}

function formatLength(m: number): string {
  const scales = [
    { exp: 3, suf: "km" },
    { exp: 0, suf: "m" },
    { exp: -2, suf: "cm" },
    { exp: -3, suf: "mm" },
    { exp: -6, suf: "um" },
    { exp: -9, suf: "nm" },
  ];
  const abs = Math.abs(m);
  for (const s of scales) {
    const scaled = abs / 10 ** s.exp;
    if (scaled >= 1) return `${(m / 10 ** s.exp).toPrecision(6).replace(/\.?0+$/, "")} ${s.suf}`;
  }
  return `${(m / 1e-9).toPrecision(6)} nm`;
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

/** Frequency/wavelength input, one of: bare number, "146 MHz", or "550 nm" style. */
function parseAnyInput(raw: string): { freqHz: number } {
  const s = (raw ?? "").trim();
  if (!s) {
    throw new ToolError(
      "empty-input",
      'Enter a frequency or a wavelength, like "146.52 MHz" or "550 nm".',
      'Try "915 MHz", "2.4GHz", "550nm", or "21cm".',
    );
  }
  const compact = s.toLowerCase().replace(/\s+/g, "");
  const isFreq = FREQ_SUFFIXES.some(({ suf }) => compact.endsWith(suf));
  const isLen = LEN_SUFFIXES.some(({ suf }) => compact.endsWith(suf));

  if (isFreq && !isLen) return { freqHz: parseFrequencyHz(s) };
  if (isLen && !isFreq) {
    const wavelengthM = parseWavelengthM(s);
    assertPositive("wavelength", wavelengthM);
    return { freqHz: C / wavelengthM };
  }
  if (isFreq && isLen) {
    // Ambiguous overlap: "hz" is a suffix of nothing here, but "m" (meters) also
    // matches nothing in FREQ_SUFFIXES, so this branch is unreachable today. Kept
    // for safety if a future unit is added with overlapping suffixes.
    return { freqHz: parseFrequencyHz(s) };
  }
  throw new ToolError(
    "bad-unit",
    `Could not recognize a frequency or wavelength unit in "${s}".`,
    'Use Hz, kHz, MHz, GHz, or THz for a frequency, or nm, um, mm, cm, m, or km for a wavelength, like "146.52 MHz" or "550nm".',
  );
}

export function run(input: string, opts: WavelengthFrequencyOpts): WavelengthFrequencyResult {
  const { freqHz } = parseAnyInput(input);
  assertPositive("frequency", freqHz);

  const vf =
    typeof opts.velocityFactor === "number" && opts.velocityFactor > 0 && opts.velocityFactor <= 1
      ? opts.velocityFactor
      : 1;

  const wavelengthFreeSpaceM = C / freqHz;
  const periodS = 1 / freqHz;
  const photonEnergyJ = PLANCK * freqHz;
  const photonEnergyEv = photonEnergyJ / ELEMENTARY_CHARGE;

  const out: WavelengthFrequencyResult = {};
  out["Frequency"] = formatFreq(freqHz);
  out["Wavelength (free space / vacuum)"] = formatLength(wavelengthFreeSpaceM);
  out["Period"] = periodS >= 1 ? `${periodS.toFixed(6)} s` : `${(periodS * 1e9).toPrecision(6)} ns`;
  out["Photon energy"] =
    `${photonEnergyEv.toExponential(4)} eV (${photonEnergyJ.toExponential(4)} J)`;

  const band = bandForFrequency(freqHz);
  if (band) {
    out["ITU band"] = band.commonName ? `${band.name}, commonly ${band.commonName}` : band.name;
  } else if (freqHz >= 3e12) {
    out["ITU band"] =
      "Above THF (3 THz): this is infrared, visible, ultraviolet or higher, not an ITU radio band designation.";
  }

  if (vf !== 1) {
    const wavelengthCableM = wavelengthFreeSpaceM * vf;
    out["Wavelength in cable / medium"] =
      `${formatLength(wavelengthCableM)} (velocity factor ${vf})`;
  }

  out["Formula"] = "wavelength = c / f; period = 1 / f; photon energy = h x f";

  return out;
}

export default { run } satisfies ToolLogic<
  string,
  WavelengthFrequencyResult,
  WavelengthFrequencyOpts
>;

// Exported for tests only; not part of the tool's public logic surface.
export const __test__ = {
  parseFrequencyHz,
  parseWavelengthM,
  bandForFrequency,
  formatFreq,
  formatLength,
};
