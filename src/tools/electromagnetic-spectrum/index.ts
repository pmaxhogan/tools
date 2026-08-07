import { ToolError, type ToolLogic } from "../types";
import {
  AXIS_MAX_HZ,
  AXIS_MIN_HZ,
  BANDS,
  C,
  E_CHARGE,
  H,
  IONIZING_EV,
  WIEN_B,
  type Band,
} from "./data";

/**
 * Electromagnetic Spectrum: the pure logic layer.
 *
 * Everything here is deterministic and free of the DOM, so the panel and the
 * curl endpoint share one source of truth for the physics, the band lookup, the
 * log10 position mapping the renderer draws on, and the jump input parser.
 *
 * Frequency (hertz) is the internal currency: every quantity converts to and
 * from a frequency, and the axis is a log10 map of frequency.
 */

export { AXIS_MAX_HZ, AXIS_MIN_HZ, BANDS, C, E_CHARGE, H, IONIZING_EV, WIEN_B };
export type { Band };

/* ------------------------------------------------------------------ */
/* Core conversions                                                    */
/* ------------------------------------------------------------------ */

/** Wavelength (meters) from frequency (hertz): lambda = c / f. */
export function frequencyToWavelength(freqHz: number): number {
  return C / freqHz;
}

/** Frequency (hertz) from wavelength (meters): f = c / lambda. */
export function wavelengthToFrequency(wavelengthM: number): number {
  return C / wavelengthM;
}

/** Photon energy in joules: E = h * f. */
export function frequencyToEnergyJoules(freqHz: number): number {
  return H * freqHz;
}

/** Photon energy in electronvolts: E_eV = h * f / e. */
export function frequencyToEnergyEv(freqHz: number): number {
  return (H * freqHz) / E_CHARGE;
}

/** Frequency (hertz) from a photon energy in electronvolts. */
export function energyEvToFrequency(ev: number): number {
  return (ev * E_CHARGE) / H;
}

/** Frequency (hertz) from a photon energy in joules. */
export function energyJoulesToFrequency(joules: number): number {
  return joules / H;
}

/**
 * The black-body temperature (kelvin) whose Planck emission peaks at this
 * wavelength, from Wien's displacement law: T = b / lambda.
 */
export function wavelengthToBlackbodyKelvin(wavelengthM: number): number {
  return WIEN_B / wavelengthM;
}

/** The Wien peak temperature for a frequency: T = b * f / c. */
export function frequencyToBlackbodyKelvin(freqHz: number): number {
  return (WIEN_B * freqHz) / C;
}

/**
 * Whether radiation at this frequency is generally considered ionizing. The
 * boundary is approximate (see IONIZING_EV); callers should present it as such.
 */
export function isIonizing(freqHz: number): boolean {
  return frequencyToEnergyEv(freqHz) >= IONIZING_EV;
}

/* ------------------------------------------------------------------ */
/* Visible light to sRGB                                               */
/* ------------------------------------------------------------------ */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Lower and upper edges of the modeled visible range, in nanometers. */
export const VISIBLE_MIN_NM = 380;
export const VISIBLE_MAX_NM = 750;

/**
 * Approximate sRGB color for a visible wavelength, in nanometers. Returns null
 * outside the visible range. Based on the widely used piecewise approximation
 * (Dan Bruton), with an intensity rolloff near the edges and gamma 0.8.
 */
export function wavelengthNmToRgb(nm: number): Rgb | null {
  if (!(nm >= VISIBLE_MIN_NM && nm <= VISIBLE_MAX_NM)) return null;

  let r = 0;
  let g = 0;
  let b = 0;

  if (nm < 440) {
    r = -(nm - 440) / (440 - 380);
    b = 1;
  } else if (nm < 490) {
    g = (nm - 440) / (490 - 440);
    b = 1;
  } else if (nm < 510) {
    g = 1;
    b = -(nm - 510) / (510 - 490);
  } else if (nm < 580) {
    r = (nm - 510) / (580 - 510);
    g = 1;
  } else if (nm < 645) {
    r = 1;
    g = -(nm - 645) / (645 - 580);
  } else {
    r = 1;
  }

  // Intensity falls off toward the edges of vision.
  let factor = 1;
  if (nm < 420) factor = 0.3 + (0.7 * (nm - 380)) / (420 - 380);
  else if (nm > 700) factor = 0.3 + (0.7 * (750 - nm)) / (750 - 700);

  const gamma = 0.8;
  const adjust = (c: number): number =>
    c === 0 ? 0 : Math.round(255 * Math.pow(c * factor, gamma));

  return { r: adjust(r), g: adjust(g), b: adjust(b) };
}

/** "#rrggbb" for an Rgb triple. */
export function rgbToHex({ r, g, b }: Rgb): string {
  const h = (n: number): string => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Approximate sRGB hex for a frequency, or null if it is not visible. */
export function frequencyToColorHex(freqHz: number): string | null {
  const nm = frequencyToWavelength(freqHz) * 1e9;
  const rgb = wavelengthNmToRgb(nm);
  return rgb ? rgbToHex(rgb) : null;
}

/* ------------------------------------------------------------------ */
/* Log10 axis position mapping                                         */
/* ------------------------------------------------------------------ */

/** Total number of decades the modeled axis spans. */
export const AXIS_DECADES = Math.log10(AXIS_MAX_HZ) - Math.log10(AXIS_MIN_HZ);

/** Clamp a number to a closed range. */
function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Normalized 0..1 position of a frequency along the axis. Position 0 is the
 * high frequency end (gamma, the start of the drawing) and position 1 is the low
 * frequency end (ELF radio). The mapping is log10 and clamped to the modeled
 * range so callers never read off the ends.
 */
export function frequencyToPosition(
  freqHz: number,
  minHz: number = AXIS_MIN_HZ,
  maxHz: number = AXIS_MAX_HZ,
): number {
  const logMin = Math.log10(minHz);
  const logMax = Math.log10(maxHz);
  const pos = (logMax - Math.log10(freqHz)) / (logMax - logMin);
  return clamp(pos, 0, 1);
}

/** Inverse of frequencyToPosition: the frequency at a normalized position. */
export function positionToFrequency(
  pos: number,
  minHz: number = AXIS_MIN_HZ,
  maxHz: number = AXIS_MAX_HZ,
): number {
  const logMin = Math.log10(minHz);
  const logMax = Math.log10(maxHz);
  const p = clamp(pos, 0, 1);
  const logF = logMax - p * (logMax - logMin);
  return Math.pow(10, logF);
}

/* ------------------------------------------------------------------ */
/* Band lookup and flattening                                          */
/* ------------------------------------------------------------------ */

/** True when a frequency falls inside a band's half open range. */
function inBand(freqHz: number, band: Band): boolean {
  return freqHz >= band.fLow && freqHz <= band.fHigh;
}

/** Log10 width of a band, used to break ties toward the most specific band. */
function bandLogWidth(band: Band): number {
  return Math.log10(band.fHigh) - Math.log10(band.fLow);
}

/**
 * The path of bands from the top level down to the most specific band that
 * contains a frequency, for example [Radio, VHF, FM broadcast]. When sibling
 * bands overlap (congested application bands can), the narrowest match wins so
 * the readout is the most specific. Returns [] when nothing contains it.
 */
export function bandPathAt(freqHz: number): Band[] {
  const path: Band[] = [];
  let level: Band[] | undefined = BANDS;

  while (level) {
    const matches = level.filter((b) => inBand(freqHz, b));
    if (matches.length === 0) break;
    // Narrowest containing band wins ties from overlapping application bands.
    matches.sort((a, b) => bandLogWidth(a) - bandLogWidth(b));
    const chosen = matches[0]!;
    path.push(chosen);
    level = chosen.children;
  }

  return path;
}

/** A "Radio > VHF > FM broadcast" style string for a band path. */
export function bandPathLabel(path: Band[]): string {
  return path.map((b) => b.name).join(" > ");
}

/**
 * The uses to show for a frequency: the deepest band on the path that lists any
 * uses. Falls back to the top level band, then to an empty array.
 */
export function usesAt(freqHz: number): string[] {
  const path = bandPathAt(freqHz);
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i]!.uses.length) return path[i]!.uses;
  }
  return [];
}

/**
 * Every band, at any depth, whose range contains a frequency. Unlike bandPathAt
 * this does not stop at the narrowest child: it descends into every matching
 * branch, so overlapping allocations (Wi-Fi, Bluetooth, Zigbee and ovens all in
 * the 2.4 GHz ISM band) are all returned.
 */
export function bandsCoveringAt(freqHz: number): Band[] {
  const acc: Band[] = [];
  const walk = (bands: Band[]) => {
    for (const band of bands) {
      if (inBand(freqHz, band)) {
        acc.push(band);
        if (band.children) walk(band.children);
      }
    }
  };
  walk(BANDS);
  return acc;
}

/** How many uses the aggregated readout shows before it is cut for readability. */
export const MAX_AGGREGATED_USES = 8;

/**
 * All uses that apply at a frequency, gathered from every band that covers the
 * point and ordered most specific (narrowest band) first, deduplicated and
 * capped. This is what the readout shows so a shared frequency lists all of its
 * real world uses, not just the single narrowest one.
 */
export function aggregatedUses(freqHz: number): string[] {
  const covering = bandsCoveringAt(freqHz).sort((a, b) => bandLogWidth(a) - bandLogWidth(b));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const band of covering) {
    for (const use of band.uses) {
      if (!seen.has(use)) {
        seen.add(use);
        out.push(use);
        if (out.length >= MAX_AGGREGATED_USES) return out;
      }
    }
  }
  return out;
}

/** A flat band with its depth, for the renderer to lay out as nested rows. */
export interface FlatBand {
  band: Band;
  depth: number;
}

/** Depth first flatten of the tree, parents before children. */
export function flattenBands(bands: Band[] = BANDS, depth = 0): FlatBand[] {
  const out: FlatBand[] = [];
  for (const band of bands) {
    out.push({ band, depth });
    if (band.children) out.push(...flattenBands(band.children, depth + 1));
  }
  return out;
}

/** The maximum nesting depth of the tree, for row layout. */
export function maxDepth(bands: Band[] = BANDS): number {
  let d = 0;
  for (const band of bands) {
    if (band.children) d = Math.max(d, 1 + maxDepth(band.children));
  }
  return d;
}

/* ------------------------------------------------------------------ */
/* Formatting helpers (pure, tested)                                   */
/* ------------------------------------------------------------------ */

/** Round to a small number of significant figures for display. */
function sig(n: number, figs = 4): string {
  if (n === 0) return "0";
  const rounded = Number(n.toPrecision(figs));
  // Keep plain decimal for human ranges, scientific for the extremes.
  if (Math.abs(rounded) >= 1e-4 && Math.abs(rounded) < 1e7) {
    return String(rounded);
  }
  return rounded.toExponential(figs - 1);
}

interface Scale {
  factor: number;
  prefix: string;
}

const FREQ_SCALES: Scale[] = [
  { factor: 1e24, prefix: "YHz" },
  { factor: 1e21, prefix: "ZHz" },
  { factor: 1e18, prefix: "EHz" },
  { factor: 1e15, prefix: "PHz" },
  { factor: 1e12, prefix: "THz" },
  { factor: 1e9, prefix: "GHz" },
  { factor: 1e6, prefix: "MHz" },
  { factor: 1e3, prefix: "kHz" },
  { factor: 1, prefix: "Hz" },
];

/** Frequency with an SI prefix, for example "2.45 GHz" or "545.1 THz". */
export function formatFrequency(freqHz: number): string {
  for (const s of FREQ_SCALES) {
    if (freqHz >= s.factor) return `${sig(freqHz / s.factor)} ${s.prefix}`;
  }
  return `${sig(freqHz)} Hz`;
}

const LENGTH_SCALES: Scale[] = [
  { factor: 1e3, prefix: "km" },
  { factor: 1, prefix: "m" },
  { factor: 1e-2, prefix: "cm" },
  { factor: 1e-3, prefix: "mm" },
  { factor: 1e-6, prefix: "um" },
  { factor: 1e-9, prefix: "nm" },
  { factor: 1e-12, prefix: "pm" },
];

/** Wavelength with a sensible metric unit, for example "550 nm" or "12.24 cm". */
export function formatWavelength(meters: number): string {
  for (const s of LENGTH_SCALES) {
    if (meters >= s.factor) return `${sig(meters / s.factor)} ${s.prefix}`;
  }
  return `${sig(meters / 1e-15)} fm`;
}

const EV_SCALES: Scale[] = [
  { factor: 1e9, prefix: "GeV" },
  { factor: 1e6, prefix: "MeV" },
  { factor: 1e3, prefix: "keV" },
  { factor: 1, prefix: "eV" },
  { factor: 1e-3, prefix: "meV" },
  { factor: 1e-6, prefix: "ueV" },
];

/** Photon energy with an SI prefix on electronvolts. */
export function formatEnergyEv(ev: number): string {
  for (const s of EV_SCALES) {
    if (ev >= s.factor) return `${sig(ev / s.factor)} ${s.prefix}`;
  }
  return `${ev.toExponential(3)} eV`;
}

/** Temperature in kelvin, grouped with thousands separators. */
export function formatKelvin(k: number): string {
  if (k >= 1e6 || k < 1e-2) return `${k.toExponential(3)} K`;
  return `${Number(k.toPrecision(4)).toLocaleString("en-US")} K`;
}

/* ------------------------------------------------------------------ */
/* Jump input parser                                                   */
/* ------------------------------------------------------------------ */

/** SI prefixes, case sensitive per the SI (m milli, M mega, and so on). */
const SI_PREFIX: Record<string, number> = {
  y: 1e-24,
  z: 1e-21,
  a: 1e-18,
  f: 1e-15,
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  µ: 1e-6, // micro sign
  μ: 1e-6, // Greek small mu
  m: 1e-3,
  c: 1e-2,
  d: 1e-1,
  "": 1,
  da: 1e1,
  h: 1e2,
  k: 1e3,
  K: 1e3, // tolerated casual kilo
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Z: 1e21,
  Y: 1e24,
};

/** Whole word length units that carry no SI prefix, mapped to meters. */
const WORD_LENGTH: Record<string, number> = {
  micron: 1e-6,
  microns: 1e-6,
  angstrom: 1e-10,
  angstroms: 1e-10,
  å: 1e-10, // a-ring
  mile: 1609.344,
  miles: 1609.344,
  mi: 1609.344,
  inch: 0.0254,
  inches: 0.0254,
  in: 0.0254,
  '"': 0.0254,
  foot: 0.3048,
  feet: 0.3048,
  ft: 0.3048,
  "'": 0.3048,
  yard: 0.9144,
  yards: 0.9144,
  yd: 0.9144,
};

const PARSE_FIX =
  "Enter a frequency (2.45 GHz, 100 MHz, 1e15 Hz), a wavelength (550 nm, 21 cm, 1 m, 1 mile), or a photon energy (1 eV, 10 keV, 2 MeV). Energy prefixes are case sensitive: meV is milli, MeV is mega.";

/** Split a leading signed number (with optional exponent) from a unit tail. */
function splitNumberUnit(text: string): { value: number; unit: string } | null {
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(.*)$/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  return { value, unit: match[2]!.trim() };
}

type Quantity = "frequency" | "wavelength" | "energyEv" | "energyJoule";

interface ResolvedUnit {
  quantity: Quantity;
  factor: number;
  /**
   * A case-folded alternate multiplier, frequency only. Used when the strict SI
   * reading lands off the modeled axis (for example "mhz" strictly means
   * milli-Hz, below the 3 Hz floor, but the user meant MHz).
   */
  altFactor?: number;
}

/** Resolve a unit string to a quantity kind and a multiplier to that base. */
function resolveUnit(unit: string): ResolvedUnit | null {
  if (unit === "") return { quantity: "frequency", factor: 1 };

  const lower = unit.toLowerCase();
  if (lower in WORD_LENGTH) return { quantity: "wavelength", factor: WORD_LENGTH[lower]! };

  // Base suffixes, longest first so "hz" and "ev" win before the bare "m".
  const bases: { suffix: string; quantity: Quantity }[] = [
    { suffix: "hz", quantity: "frequency" },
    { suffix: "ev", quantity: "energyEv" },
    { suffix: "j", quantity: "energyJoule" },
    { suffix: "m", quantity: "wavelength" },
  ];

  for (const base of bases) {
    if (!lower.endsWith(base.suffix)) continue;
    const prefixRaw = unit.slice(0, unit.length - base.suffix.length);
    const foldedKey = prefixRaw.toUpperCase();
    const foldedFactor = foldedKey in SI_PREFIX ? SI_PREFIX[foldedKey]! : undefined;

    // Energy on eV stays case sensitive (meV is milli, MeV is mega). Frequency
    // may fold, but only as a fallback that parseJump applies when the strict
    // reading is off-axis.
    if (prefixRaw in SI_PREFIX) {
      const strict = SI_PREFIX[prefixRaw]!;
      const alt =
        base.quantity === "frequency" && foldedKey !== prefixRaw && foldedFactor !== undefined
          ? foldedFactor
          : undefined;
      return { quantity: base.quantity, factor: strict, altFactor: alt };
    }

    // Prefix not a strict SI prefix. For frequency, accept a case-folded prefix
    // outright ("100 mhZ"); for anything else this is an unknown unit.
    if (base.quantity === "frequency" && foldedFactor !== undefined) {
      return { quantity: "frequency", factor: foldedFactor };
    }
    return null;
  }
  return null;
}

/**
 * Parse a jump target into a frequency in hertz. Accepts a frequency, a
 * wavelength or a photon energy in the many forms resolveUnit knows. Throws a
 * ToolError with an actionable fix hint for anything it cannot read.
 */
export function parseJump(input: string): number {
  const text = String(input ?? "").trim();
  if (!text) {
    throw new ToolError("empty-input", "Enter something to jump to.", PARSE_FIX);
  }

  const split = splitNumberUnit(text);
  if (!split) {
    throw new ToolError("invalid-number", `Could not read a number in "${text}".`, PARSE_FIX);
  }

  const resolved = resolveUnit(split.unit);
  if (!resolved) {
    throw new ToolError("unknown-unit", `Unknown unit "${split.unit}".`, PARSE_FIX);
  }

  let magnitude = split.value * resolved.factor;
  if (!(magnitude > 0)) {
    throw new ToolError(
      "non-positive",
      "The value must be a positive number.",
      "Frequency, wavelength and energy are all positive quantities.",
    );
  }

  // For frequency, if the strict SI reading falls off the modeled axis but a
  // case-folded prefix lands on it, take the folded reading ("100 mhz" is MHz).
  if (
    resolved.quantity === "frequency" &&
    resolved.altFactor !== undefined &&
    (magnitude < AXIS_MIN_HZ || magnitude > AXIS_MAX_HZ)
  ) {
    const alt = split.value * resolved.altFactor;
    if (alt >= AXIS_MIN_HZ && alt <= AXIS_MAX_HZ) magnitude = alt;
  }

  let freqHz: number;
  switch (resolved.quantity) {
    case "frequency":
      freqHz = magnitude;
      break;
    case "wavelength":
      freqHz = wavelengthToFrequency(magnitude);
      break;
    case "energyEv":
      freqHz = energyEvToFrequency(magnitude);
      break;
    case "energyJoule":
      freqHz = energyJoulesToFrequency(magnitude);
      break;
  }

  if (!Number.isFinite(freqHz) || freqHz <= 0) {
    throw new ToolError("out-of-range", "That value does not map to a real frequency.", PARSE_FIX);
  }

  return freqHz;
}

/* ------------------------------------------------------------------ */
/* Full readout and the tool run()                                     */
/* ------------------------------------------------------------------ */

/** Everything the readout and tooltip show for one frequency. */
export interface Readout {
  frequencyHz: number;
  wavelengthM: number;
  energyEv: number;
  energyJoule: number;
  blackbodyKelvin: number;
  ionizing: boolean;
  colorHex: string | null;
  path: Band[];
  pathLabel: string;
  uses: string[];
}

/** Build the full readout for a frequency in hertz. */
export function describeFrequency(freqHz: number): Readout {
  const path = bandPathAt(freqHz);
  return {
    frequencyHz: freqHz,
    wavelengthM: frequencyToWavelength(freqHz),
    energyEv: frequencyToEnergyEv(freqHz),
    energyJoule: frequencyToEnergyJoules(freqHz),
    blackbodyKelvin: frequencyToBlackbodyKelvin(freqHz),
    ionizing: isIonizing(freqHz),
    colorHex: frequencyToColorHex(freqHz),
    path,
    pathLabel: bandPathLabel(path) || "Outside the modeled bands",
    uses: aggregatedUses(freqHz),
  };
}

/** Readout as labeled, copyable rows for the generic shell and the curl API. */
export function readoutRows(r: Readout): Record<string, string> {
  return {
    Frequency: formatFrequency(r.frequencyHz),
    Wavelength: formatWavelength(r.wavelengthM),
    "Photon energy": formatEnergyEv(r.energyEv),
    "Black-body peak": formatKelvin(r.blackbodyKelvin),
    Band: r.pathLabel,
    Ionizing: r.ionizing ? "Yes (approximate, at or above 10 eV)" : "No",
    Color: r.colorHex ?? "Not in the visible band",
    "Common uses": r.uses.length ? r.uses.join(", ") : "None listed",
  };
}

export interface SpectrumOpts {
  /** The jump target: a frequency, wavelength or energy string. */
  query?: string;
  [key: string]: unknown;
}

/**
 * The tool as a pure transform. Input is 'none'; the query arrives through the
 * `query` option (so the curl endpoint works as ?query=2.45+GHz). Falls back to
 * a plain string input if one is passed, then to a sensible default of 550 nm
 * (green light) so an empty call still returns a useful readout.
 */
export function run(input: unknown, opts: SpectrumOpts = {}): Record<string, string> {
  const raw =
    (typeof opts.query === "string" && opts.query.trim()) ||
    (typeof input === "string" && input.trim()) ||
    "550 nm";
  const freqHz = parseJump(raw);
  return readoutRows(describeFrequency(freqHz));
}

export default { run } satisfies ToolLogic<unknown, Record<string, string>, SpectrumOpts>;
