import { ToolError, type ToolLogic } from "../types";
import {
  AXIS_MAX_HZ,
  AXIS_MIN_HZ,
  BANDS,
  C,
  E_CHARGE,
  H,
  ICON_NAMES,
  IONIZING_EV,
  NAMED_CHANNELS,
  WIEN_B,
  WIFI_CHANNELS,
  type Band,
  type ChannelService,
  type NamedChannel,
  type WifiBand,
  type WifiChannel,
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

export {
  AXIS_MAX_HZ,
  AXIS_MIN_HZ,
  BANDS,
  C,
  E_CHARGE,
  H,
  ICON_NAMES,
  IONIZING_EV,
  NAMED_CHANNELS,
  WIEN_B,
  WIFI_CHANNELS,
};
export type { Band, ChannelService, NamedChannel, WifiBand, WifiChannel };

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
/* Wi-Fi channel lookup                                                */
/* ------------------------------------------------------------------ */

/** Sort key so the three Wi-Fi bands order 2.4, then 5, then 6. */
function wifiBandOrder(band: WifiBand): number {
  return band === "2.4" ? 0 : band === "5" ? 1 : 2;
}

/**
 * Every US / North American Wi-Fi channel matching a query. `channel` is
 * required; `band` and `width` narrow the result when given. Results are ordered
 * narrowest width first (so the plain 20 MHz reading leads), then by band. When
 * a channel number is ambiguous across bands (channel 1 exists at 2.4 GHz and 6
 * GHz), every matching band is returned.
 */
export function findWifiChannels(query: {
  band?: WifiBand;
  channel: number;
  width?: number;
}): WifiChannel[] {
  return WIFI_CHANNELS.filter(
    (c) =>
      c.channel === query.channel &&
      (query.band === undefined || c.band === query.band) &&
      (query.width === undefined || c.width === query.width),
  ).sort((a, b) => a.width - b.width || wifiBandOrder(a.band) - wifiBandOrder(b.band));
}

/* ------------------------------------------------------------------ */
/* Named / numbered channel lookup (marine, CB, NOAA, FM, TV)          */
/* ------------------------------------------------------------------ */

/**
 * Normalize a channel identifier for comparison: uppercase, strip whitespace and
 * drop leading zeros on the numeric part ("05a" and "5A" both become "5A", "016"
 * becomes "16"). Keeps the "WX" prefix and any trailing "A" variant letter.
 */
function normChannelId(id: string): string {
  return String(id)
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/^0+(?=\d)/, "");
}

/**
 * Every named or numbered channel matching a query. `channel` may be a canonical
 * id ("22A", "WX1", "201") or a bare number; a bare number matches by the
 * channel's numeric part, so "marine 22" finds the channel a user knows as 22A.
 * `service` narrows the result when given. Results are ordered by service then by
 * channel number.
 */
export function findNamedChannels(query: {
  service?: ChannelService;
  channel: string | number;
}): NamedChannel[] {
  const q = normChannelId(String(query.channel));
  const qNum = /^\d+$/.test(q) ? Number(q) : null;
  return NAMED_CHANNELS.filter((c) => {
    if (query.service !== undefined && c.service !== query.service) return false;
    if (normChannelId(c.channel) === q) return true;
    return qNum !== null && c.number === qNum;
  }).sort((a, b) => a.service.localeCompare(b.service) || a.number - b.number);
}

/* ------------------------------------------------------------------ */
/* The "jump to" search brain: interpretQuery                          */
/* ------------------------------------------------------------------ */

/**
 * One candidate reading of a search box query. The panel renders these as a
 * dropdown and Enter picks the first. `frequencyHz` is always the jump target;
 * `rangeHz` (when present) lets the panel zoom to fit a band or channel.
 */
export interface Interpretation {
  /** Stable key for v-for. */
  id: string;
  /** What kind of reading produced this candidate. */
  kind: "frequency" | "wavelength" | "energy" | "band" | "wifi" | "channel";
  /** Primary label, for example "2.462 GHz" or "VHF". */
  label: string;
  /** Secondary line, for example a band path or the channel width. */
  detail?: string;
  /** The jump target in hertz. */
  frequencyHz: number;
  /** Low and high edges in hertz, so the panel can zoom to fit. */
  rangeHz?: [number, number];
  /** Optional lucide-vue-next icon name. */
  icon?: string;
}

/** How many candidates the dropdown holds before the list is cut. */
export const MAX_INTERPRETATIONS = 8;

/*
 * Ranking, best first:
 *   1. An exact numeric-plus-unit parse (a frequency, wavelength or energy).
 *      This is the most literal reading of what the user typed, so it leads.
 *   2. Exact channel matches. A named service query (marine, CB, NOAA, FM, TV)
 *      resolves to that service's channel; otherwise a Wi-Fi channel query
 *      resolves to the Wi-Fi channel, narrowest width first then by band.
 *   3. Fuzzy band-name and abbreviation matches, by match strength (an exact
 *      name or alias above a whole-word substring), then narrowest band first.
 * Duplicates (by id) are dropped keeping the earliest, and the list is capped at
 * MAX_INTERPRETATIONS for the dropdown.
 */

/** Turn a resolved numeric quantity into a candidate, or null if it will not parse. */
function interpretNumeric(text: string): Interpretation | null {
  const split = splitNumberUnit(text);
  if (!split) return null;
  const resolved = resolveUnit(split.unit);
  if (!resolved) return null;

  let freqHz: number;
  try {
    freqHz = parseJump(text);
  } catch {
    return null;
  }

  const wl = frequencyToWavelength(freqHz);
  const ev = frequencyToEnergyEv(freqHz);
  const freqLabel = formatFrequency(freqHz);

  if (resolved.quantity === "frequency") {
    return {
      id: `num-frequency-${freqHz}`,
      kind: "frequency",
      label: freqLabel,
      detail: `${formatWavelength(wl)}, ${formatEnergyEv(ev)}`,
      frequencyHz: freqHz,
    };
  }
  if (resolved.quantity === "wavelength") {
    return {
      id: `num-wavelength-${freqHz}`,
      kind: "wavelength",
      label: formatWavelength(wl),
      detail: `${freqLabel}, ${formatEnergyEv(ev)}`,
      frequencyHz: freqHz,
    };
  }
  // energyEv or energyJoule both present as a photon energy.
  return {
    id: `num-energy-${freqHz}`,
    kind: "energy",
    label: formatEnergyEv(ev),
    detail: `${freqLabel}, ${formatWavelength(wl)}`,
    frequencyHz: freqHz,
  };
}

/**
 * Pull a US / NA Wi-Fi band hint and channel number out of a free text query.
 * Returns null when the text is not a Wi-Fi channel query or the channel does
 * not exist in any band. Understands band hints ("2.4", "2.4ghz", "5ghz", "6ghz",
 * "6e"), the words "wifi", "channel", "ch" and "ch.", and the channel number.
 */
function parseWifiQuery(raw: string): { band?: WifiBand; channel: number } | null {
  const lower = raw.toLowerCase();

  let band: WifiBand | undefined;
  if (/\b6e\b/.test(lower) || /\b6\s*ghz\b/.test(lower)) band = "6";
  else if (/\b5\s*ghz\b/.test(lower)) band = "5";
  else if (/2\.4\s*ghz/.test(lower) || /\b2\.4\b/.test(lower)) band = "2.4";

  // Strip band hints so the channel number is the only number left to read.
  const work = lower
    .replace(/2\.4\s*ghz/g, " ")
    .replace(/2\.4/g, " ")
    .replace(/\b[56]\s*ghz/g, " ")
    .replace(/\b6e\b/g, " ")
    .replace(/ghz/g, " ");

  let channel: number | undefined;
  const chMatch = /\bch(?:annel|\.)?\s*(\d{1,3})\b/.exec(work);
  if (chMatch) channel = Number(chMatch[1]);

  const hasWifi = /\bwi[\s-]?fi\b/.test(lower);
  if (channel === undefined && hasWifi) {
    const nums = work.match(/\d{1,3}/g);
    if (nums && nums.length) channel = Number(nums[nums.length - 1]);
  }

  if (channel === undefined || !Number.isFinite(channel)) return null;
  if (findWifiChannels({ band, channel }).length === 0) return null;
  return { band, channel };
}

/** Present one Wi-Fi channel as a search candidate. */
function wifiInterpretation(c: WifiChannel): Interpretation {
  return {
    id: `wifi-${c.band}-${c.channel}-${c.width}`,
    kind: "wifi",
    label: `Wi-Fi channel ${c.channel}, ${c.width} MHz (${c.band} GHz), center ${formatFrequency(
      c.centerHz,
    )}`,
    detail: `${c.band} GHz Wi-Fi band, ${c.width} MHz wide`,
    frequencyHz: c.centerHz,
    rangeHz: [c.lowerHz, c.upperHz],
    icon: "Wifi",
  };
}

/* Named / numbered channel queries (marine, CB, NOAA, FM, TV). */

/** Human label and jump icon for each channel service. */
const SERVICE_META: Record<ChannelService, { label: string; icon: string }> = {
  marine: { label: "Marine", icon: "Ship" },
  cb: { label: "CB", icon: "Antenna" },
  noaa: { label: "NOAA weather", icon: "CloudRain" },
  fm: { label: "FM", icon: "RadioReceiver" },
  tv: { label: "TV", icon: "Tv" },
};

/**
 * Detect which channel service a free text query names, or null. Marine accepts
 * "marine" and "maritime"; CB accepts "cb" and "citizens band"; NOAA accepts
 * "noaa", "weather" and the fused "wx" form; FM accepts "fm"; TV accepts "tv" and
 * "television". The fused "wx3" form is handled in parseNamedChannel.
 */
function detectService(lower: string): ChannelService | null {
  if (/\bmarine\b|\bmaritime\b/.test(lower)) return "marine";
  if (/\bcb\b|\bcitizens?\s+band\b/.test(lower)) return "cb";
  if (/\bnoaa\b|\bweather\b|\bwx\d|\bwx\b/.test(lower)) return "noaa";
  if (/\bfm\b/.test(lower)) return "fm";
  if (/\btv\b|\btelevision\b/.test(lower)) return "tv";
  return null;
}

/**
 * Pull a named channel service and channel id out of a free text query. Handles
 * "<service> channel <n>", "<service> ch <n>", a bare "<service> <n>", the marine
 * "A" simplex suffix ("marine 22a"), and the fused NOAA weather form ("wx3").
 * Returns null when no service is named or no channel number is present.
 */
function parseNamedChannel(raw: string): { service: ChannelService; channel: string } | null {
  const lower = raw.toLowerCase();
  const service = detectService(lower);
  if (service === null) return null;

  // NOAA fused form: "wx3" or "wx 3".
  if (service === "noaa") {
    const wx = /\bwx\s*(\d{1,2})\b/.exec(lower);
    if (wx) return { service, channel: wx[1]! };
  }

  // "channel 22a" or "ch 22a" or "ch. 22".
  const keyed = /\bch(?:annel|\.)?\s*(\d{1,3})\s*(a)?\b/.exec(lower);
  if (keyed) return { service, channel: keyed[1]! + (keyed[2] ? "A" : "") };

  // A bare trailing number, optionally with the marine "A" suffix.
  const bare = /\b(\d{1,3})\s*(a)?\b/.exec(lower);
  if (bare) return { service, channel: bare[1]! + (bare[2] ? "A" : "") };

  return null;
}

/** Present one named channel as a search candidate. */
function namedChannelInterpretation(c: NamedChannel): Interpretation {
  const meta = SERVICE_META[c.service];
  const detailBits = [formatFrequency(c.centerHz)];
  if (c.uses && c.uses.length) detailBits.push(c.uses[0]!);
  return {
    id: `chan-${c.service}-${c.channel}`,
    kind: "channel",
    label: `${meta.label} channel ${c.channel}`,
    detail: detailBits.join(", "),
    frequencyHz: c.centerHz,
    rangeHz: [c.lowerHz, c.upperHz],
    icon: meta.icon,
  };
}

/** Escape a string for safe use inside a regular expression. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `needle` appears in `haystack` bounded by non alphanumeric edges. */
function wholeWordMatch(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const re = new RegExp(`(?<![a-z0-9])${escapeRegExp(needle)}(?![a-z0-9])`);
  return re.test(haystack);
}

/** Match strength of a band against a query: 3 exact, 2 whole word, 0 none. */
function scoreBand(band: Band, query: string): number {
  const terms = [band.name.toLowerCase(), ...(band.aliases ?? [])];
  let best = 0;
  for (const term of terms) {
    if (term === query) best = Math.max(best, 3);
    else if (wholeWordMatch(term, query) || wholeWordMatch(query, term)) best = Math.max(best, 2);
  }
  return best;
}

interface BandMatch {
  band: Band;
  path: Band[];
  score: number;
}

/** Every band whose name or aliases match the query, with its ancestry path. */
function searchBands(query: string): BandMatch[] {
  const out: BandMatch[] = [];
  const walk = (bands: Band[], ancestors: Band[]) => {
    for (const band of bands) {
      const path = [...ancestors, band];
      const score = scoreBand(band, query);
      if (score > 0) out.push({ band, path, score });
      if (band.children) walk(band.children, path);
    }
  };
  walk(BANDS, []);
  return out;
}

/** Present one band as a search candidate, centered on the geometric mean. */
function bandInterpretation(band: Band, path: Band[]): Interpretation {
  return {
    id: `band-${band.id}`,
    kind: "band",
    label: band.name,
    detail: bandPathLabel(path),
    // The axis is log10, so the visual center of a band is the geometric mean.
    frequencyHz: Math.sqrt(band.fLow * band.fHigh),
    rangeHz: [band.fLow, band.fHigh],
    icon: band.icon,
  };
}

/**
 * Interpret a free text search query into a ranked list of jump candidates. The
 * panel shows these in a dropdown and Enter picks the first. Returns an empty
 * array when nothing sensible parses. Never throws (a bad numeric parse is
 * simply dropped from the candidate list).
 */
export function interpretQuery(input: string): Interpretation[] {
  const text = String(input ?? "").trim();
  if (!text) return [];

  const candidates: Interpretation[] = [];

  // 1. Numeric plus unit (frequency, wavelength or energy).
  const numeric = interpretNumeric(text);
  if (numeric) candidates.push(numeric);

  // 2. Named / numbered channel matches (marine, CB, NOAA, FM, TV). When the
  // query names a service the Wi-Fi step is skipped: colliding channel numbers
  // exist in the Wi-Fi dataset (a 6 GHz channel 201, a 2.4 GHz channel 7), so
  // "fm channel 201" or "tv channel 7" must resolve to the named service, not
  // Wi-Fi. Wi-Fi still handles the bare and "wifi" flavored channel queries.
  const named = parseNamedChannel(text);
  if (named) {
    for (const c of findNamedChannels(named)) candidates.push(namedChannelInterpretation(c));
  } else {
    const wifi = parseWifiQuery(text);
    if (wifi) {
      for (const c of findWifiChannels({ band: wifi.band, channel: wifi.channel })) {
        candidates.push(wifiInterpretation(c));
      }
    }
  }

  // 3. Fuzzy band and abbreviation search.
  const query = text.toLowerCase();
  if (query.length >= 2) {
    const matches = searchBands(query).sort(
      (a, b) => b.score - a.score || bandLogWidth(a.band) - bandLogWidth(b.band),
    );
    for (const m of matches) candidates.push(bandInterpretation(m.band, m.path));
  }

  // Deduplicate by id (keeping the earliest, best ranked) and cap the list.
  const seen = new Set<string>();
  const ranked: Interpretation[] = [];
  for (const it of candidates) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    ranked.push(it);
    if (ranked.length >= MAX_INTERPRETATIONS) break;
  }
  return ranked;
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
    // Show only the most specific selected band's uses (the deepest band on the
    // path that lists any), not the aggregated pile from every covering band.
    // aggregatedUses stays exported for callers that want the full set.
    uses: usesAt(freqHz),
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
