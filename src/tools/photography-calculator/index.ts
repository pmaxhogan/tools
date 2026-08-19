import { ToolError, type ToolLogic } from "../types";

export interface PhotographyCalculatorOpts {
  /** "dof" | "hyperfocal" | "exposure" | "nd" | "fov" */
  mode?: string;
  /** Sensor id, see SENSORS. "custom" reads sensorWidth/sensorHeight/coc tokens. */
  sensor?: string;
  [key: string]: unknown;
}

export type PhotographyCalculatorResult = Record<string, string>;

type Mode = "dof" | "hyperfocal" | "exposure" | "nd" | "fov";

// ---------------------------------------------------------------------------
// Sensors
// ---------------------------------------------------------------------------

interface SensorSpec {
  id: string;
  label: string;
  /** Sensor width in mm. */
  width: number;
  /** Sensor height in mm. */
  height: number;
  /** Circle of confusion in mm. */
  coc: number;
}

const SENSORS: SensorSpec[] = [
  { id: "full-frame", label: "Full frame 35mm (36 x 24 mm)", width: 36, height: 24, coc: 0.03 },
  { id: "aps-c", label: "APS-C (23.6 x 15.6 mm)", width: 23.6, height: 15.6, coc: 0.02 },
  { id: "aps-c-canon", label: "Canon APS-C (22.3 x 14.9 mm)", width: 22.3, height: 14.9, coc: 0.019 },
  {
    id: "micro-four-thirds",
    label: "Micro Four Thirds (17.3 x 13 mm)",
    width: 17.3,
    height: 13,
    coc: 0.015,
  },
  { id: "1-inch", label: "1 inch type (13.2 x 8.8 mm)", width: 13.2, height: 8.8, coc: 0.011 },
  {
    id: "medium-format-44x33",
    label: "Medium format (44 x 33 mm)",
    width: 44,
    height: 33,
    coc: 0.037,
  },
];

/** Alias keys are normalized: lowercased with every non-alphanumeric stripped. */
const SENSOR_ALIASES: Record<string, string> = {
  fullframe: "full-frame",
  full: "full-frame",
  ff: "full-frame",
  "35mm": "full-frame",
  "135": "full-frame",
  fx: "full-frame",
  "36x24": "full-frame",
  apsc: "aps-c",
  aps: "aps-c",
  dx: "aps-c",
  crop: "aps-c",
  apscsony: "aps-c",
  apscnikon: "aps-c",
  "236x156": "aps-c",
  apsccanon: "aps-c-canon",
  canon: "aps-c-canon",
  canoncrop: "aps-c-canon",
  "223x149": "aps-c-canon",
  microfourthirds: "micro-four-thirds",
  mft: "micro-four-thirds",
  m43: "micro-four-thirds",
  fourthirds: "micro-four-thirds",
  olympus: "micro-four-thirds",
  panasonic: "micro-four-thirds",
  "173x13": "micro-four-thirds",
  "1inch": "1-inch",
  oneinch: "1-inch",
  "1in": "1-inch",
  "1type": "1-inch",
  cx: "1-inch",
  "132x88": "1-inch",
  mediumformat: "medium-format-44x33",
  mediumformat44x33: "medium-format-44x33",
  mf: "medium-format-44x33",
  gfx: "medium-format-44x33",
  "44x33": "medium-format-44x33",
  "645": "medium-format-44x33",
  custom: "custom",
};

const MODE_ALIASES: Record<string, Mode> = {
  dof: "dof",
  depthoffield: "dof",
  depth: "dof",
  focus: "dof",
  hyperfocal: "hyperfocal",
  hyperfocaldistance: "hyperfocal",
  hf: "hyperfocal",
  hyper: "hyperfocal",
  exposure: "exposure",
  ev: "exposure",
  exp: "exposure",
  exposurevalue: "exposure",
  sunny16: "exposure",
  nd: "nd",
  ndfilter: "nd",
  neutraldensity: "nd",
  filter: "nd",
  longexposure: "nd",
  fov: "fov",
  fieldofview: "fov",
  angleofview: "fov",
  aov: "fov",
  angle: "fov",
  view: "fov",
};

const MODE_LABEL: Record<Mode, string> = {
  dof: "Depth of field",
  hyperfocal: "Hyperfocal distance",
  exposure: "Exposure and EV",
  nd: "ND filter",
  fov: "Field of view",
};

function normalizeKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Full stop aperture series. Index i is idealized as stop number i + 1 from f/1.0. */
const FULL_STOP_APERTURES = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22];

/** Full stop shutter denominators, used to snap computed times to real dial values. */
const STANDARD_DENOMINATORS = [8000, 4000, 2000, 1000, 500, 250, 125, 60, 30, 15, 8, 4, 2];

/** Full stop ISO values. */
const STANDARD_ISOS = [
  25, 50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 51200, 102400, 204800,
];

/** Common ND filters, keyed by their marketed factor. */
const COMMON_NDS = [2, 4, 8, 64, 400, 1000, 100000];

function formatAperture(n: number): string {
  if (!Number.isFinite(n)) return "f/?";
  return Number.isInteger(n) ? `f/${n}` : `f/${n.toFixed(1)}`;
}

/** Distance in mm rendered in the caller's unit system with 2 decimals. */
function formatDistance(mm: number, imperial: boolean): string {
  if (!Number.isFinite(mm)) return "infinity";
  return imperial ? `${(mm / 304.8).toFixed(2)} ft` : `${(mm / 1000).toFixed(2)} m`;
}

function humanDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} h`);
  if (m > 0) parts.push(`${m} min`);
  if (s > 0 || parts.length === 0) parts.push(`${s} s`);
  return parts.join(" ");
}

/**
 * Render a shutter time the way a camera dial does: fractions under a second,
 * seconds rounded to the nearest half above one second. Computed times land
 * fractionally off the marked speeds (1/125 through an ND2 is 1/62.5), so a
 * value within 8% of a full stop denominator snaps onto it.
 */
function formatShutter(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "?";
  if (seconds >= 1) {
    const rounded = Math.round(seconds * 2) / 2;
    const base = Number.isInteger(rounded) ? `${rounded} s` : `${rounded.toFixed(1)} s`;
    return rounded >= 60 ? `${base} (${humanDuration(rounded)})` : base;
  }

  const den = 1 / seconds;
  let best: number | null = null;
  let bestErr = Infinity;
  for (const d of STANDARD_DENOMINATORS) {
    const err = Math.abs(den - d) / d;
    if (err < bestErr) {
      bestErr = err;
      best = d;
    }
  }
  if (best !== null && bestErr <= 0.08) return `1/${best} s`;

  const nearestInt = Math.round(den);
  if (nearestInt >= 1 && Math.abs(den - nearestInt) / den < 0.01) return `1/${nearestInt} s`;
  return den < 10 ? `1/${den.toFixed(1)} s` : `1/${Math.round(den)} s`;
}

function formatStopsDelta(stops: number): string {
  if (Math.abs(stops) < 0.05) return "right on";
  const dir = stops > 0 ? "above" : "below";
  return `${Math.abs(stops).toFixed(2)} stops ${dir}`;
}

function nearestStandardIso(iso: number): number {
  let best = STANDARD_ISOS[0];
  let bestErr = Infinity;
  for (const s of STANDARD_ISOS) {
    const err = Math.abs(Math.log2(iso / s));
    if (err < bestErr) {
      bestErr = err;
      best = s;
    }
  }
  return best;
}

/** EV100 to the everyday scene that produces it. */
const EV_SCENES: Record<number, string> = {
  16: "bright sun on snow or sand",
  15: "bright sun on a clear day",
  14: "hazy sun with soft shadows",
  13: "cloudy bright with no visible shadows",
  12: "overcast daylight",
  11: "open shade or heavy overcast",
  10: "sunset",
  9: "the minutes just after sunset",
  8: "a brightly lit city street at night",
  7: "a well lit interior",
  6: "a typical home interior",
  5: "a dim interior or candlelight",
  4: "a night street scene",
  3: "distant floodlit buildings",
  2: "a lit shop window at night",
  1: "a landscape lit by a full moon",
  0: "a night landscape under a bright moon",
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface Parsed {
  focal?: number;
  aperture?: number;
  /** Subject distance in mm. */
  distance?: number;
  /** Shutter time in seconds. */
  shutter?: number;
  iso?: number;
  ev?: number;
  /** ND strength in stops. */
  ndStops?: number;
  /** How the ND strength was written, for the output label. */
  ndLabel?: string;
  /** Target shutter time in seconds. */
  target?: number;
  sensorWidth?: number;
  sensorHeight?: number;
  coc?: number;
  sensorId?: string;
  mode?: Mode;
  /** True when any distance was written in feet or inches. */
  imperial: boolean;
}

type FieldKey =
  | "focal"
  | "aperture"
  | "distance"
  | "shutter"
  | "iso"
  | "ev"
  | "nd"
  | "target"
  | "sensorWidth"
  | "sensorHeight"
  | "coc"
  | "sensor"
  | "mode";

const KEY_MAP: Record<string, FieldKey> = {
  focal: "focal",
  focallength: "focal",
  fl: "focal",
  lens: "focal",
  mm: "focal",
  aperture: "aperture",
  ap: "aperture",
  n: "aperture",
  fstop: "aperture",
  fnumber: "aperture",
  av: "aperture",
  f: "aperture",
  distance: "distance",
  dist: "distance",
  d: "distance",
  s: "distance",
  subject: "distance",
  subjectdistance: "distance",
  focusdistance: "distance",
  shutter: "shutter",
  shutterspeed: "shutter",
  time: "shutter",
  t: "shutter",
  exposure: "shutter",
  tv: "shutter",
  iso: "iso",
  asa: "iso",
  sensitivity: "iso",
  gain: "iso",
  ev: "ev",
  ev100: "ev",
  exposurevalue: "ev",
  lightvalue: "ev",
  nd: "nd",
  ndfilter: "nd",
  filter: "nd",
  stops: "nd",
  density: "nd",
  strength: "nd",
  target: "target",
  targetshutter: "target",
  goal: "target",
  wanted: "target",
  sensorwidth: "sensorWidth",
  sw: "sensorWidth",
  width: "sensorWidth",
  sensorheight: "sensorHeight",
  sh: "sensorHeight",
  height: "sensorHeight",
  coc: "coc",
  circleofconfusion: "coc",
  c: "coc",
  sensor: "sensor",
  format: "sensor",
  camera: "sensor",
  body: "sensor",
  mode: "mode",
  calc: "mode",
  calculation: "mode",
};

function badToken(token: string, why: string, fix: string): ToolError {
  return new ToolError("bad-token", `${why} (in "${token}").`, fix);
}

/** Join a number to the unit word that follows it, so "3 stops" reads as one token. */
function normalizeInput(raw: string): string {
  return raw
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/÷/g, "/")
    .replace(/\biso\s+(\d)/gi, "iso$1")
    .replace(
      /(\d)\s+(stops?|mm|cm|km|meters?|metres?|m|feet|foot|ft|inches|inch|in|seconds?|secs?|sec|s|x)\b/gi,
      "$1$2",
    );
}

/** "50", "50mm" -> mm. */
function parseFocal(value: string, token: string): number {
  const m = value.match(/^([+-]?\d*\.?\d+)\s*(mm)?$/i);
  if (!m) {
    throw badToken(
      token,
      `Could not read "${value}" as a focal length`,
      'Write a focal length in millimetres, like "50mm" or "focal=24".',
    );
  }
  return Number(m[1]);
}

/** "f/2.8", "f2.8", "2.8" -> 2.8. */
function parseAperture(value: string, token: string): number {
  const m = value.match(/^f?\/?\s*([+-]?\d*\.?\d+)$/i);
  if (!m) {
    throw badToken(
      token,
      `Could not read "${value}" as an aperture`,
      'Write an f-number, like "f/2.8", "f2.8", or "aperture=5.6".',
    );
  }
  return Number(m[1]);
}

const DISTANCE_UNITS: Record<string, { mm: number; imperial: boolean }> = {
  mm: { mm: 1, imperial: false },
  cm: { mm: 10, imperial: false },
  m: { mm: 1000, imperial: false },
  meter: { mm: 1000, imperial: false },
  meters: { mm: 1000, imperial: false },
  metre: { mm: 1000, imperial: false },
  metres: { mm: 1000, imperial: false },
  km: { mm: 1e6, imperial: false },
  ft: { mm: 304.8, imperial: true },
  foot: { mm: 304.8, imperial: true },
  feet: { mm: 304.8, imperial: true },
  "'": { mm: 304.8, imperial: true },
  in: { mm: 25.4, imperial: true },
  inch: { mm: 25.4, imperial: true },
  inches: { mm: 25.4, imperial: true },
  '"': { mm: 25.4, imperial: true },
  yd: { mm: 914.4, imperial: true },
  yard: { mm: 914.4, imperial: true },
  yards: { mm: 914.4, imperial: true },
};

/** "3m", "10ft", "300cm", "3" -> mm plus whether the writer used imperial units. */
function parseDistance(value: string, token: string): { mm: number; imperial: boolean } {
  const m = value.match(/^([+-]?\d*\.?\d+)\s*([a-z'"]*)$/i);
  if (!m) {
    throw badToken(
      token,
      `Could not read "${value}" as a distance`,
      'Write a distance with a unit, like "3m", "300cm", or "10ft". Metres are assumed when no unit is given.',
    );
  }
  const num = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "") return { mm: num * 1000, imperial: false };
  const spec = DISTANCE_UNITS[unit];
  if (!spec) {
    throw badToken(
      token,
      `Unknown distance unit "${m[2]}"`,
      "Use mm, cm, m, km, in, ft, or yd.",
    );
  }
  return { mm: num * spec.mm, imperial: spec.imperial };
}

/** "1/250", "1/250s", "0.004", "2s", "30\"" -> seconds. */
function parseShutter(value: string, token: string): number {
  const cleaned = value.replace(/(seconds?|secs?|sec|s|")$/i, "").trim();
  const frac = cleaned.match(/^([+-]?\d*\.?\d+)\s*\/\s*([+-]?\d*\.?\d+)$/);
  if (frac) {
    const den = Number(frac[2]);
    if (den === 0) {
      throw new ToolError(
        "impossible",
        `Shutter speed "${token}" divides by zero.`,
        'Write a real fraction, like "1/250".',
      );
    }
    return Number(frac[1]) / den;
  }
  const plain = cleaned.match(/^([+-]?\d*\.?\d+)$/);
  if (!plain) {
    throw badToken(
      token,
      `Could not read "${value}" as a shutter speed`,
      'Write a fraction or a number of seconds, like "1/250", "1/250s", "0.004", "2s", or "30".',
    );
  }
  return Number(plain[1]);
}

function parseIso(value: string, token: string): number {
  const m = value.match(/^(?:iso)?\s*([+-]?\d*\.?\d+)$/i);
  if (!m) {
    throw badToken(
      token,
      `Could not read "${value}" as an ISO`,
      'Write a plain ISO number, like "iso=400" or "ISO400".',
    );
  }
  return Number(m[1]);
}

/**
 * "ND1000", "1000x", "3 stops", "0.9" -> stops of light removed.
 *
 * A bare number with a decimal point reads as optical density (0.9 is a 3 stop
 * filter); a bare whole number reads as the marketed filter factor (8 is ND8).
 */
function parseNd(value: string, token: string): { stops: number; label: string } {
  const v = value.trim();

  const stopsForm = v.match(/^([+-]?\d*\.?\d+)\s*stops?$/i);
  if (stopsForm) {
    const stops = Number(stopsForm[1]);
    return { stops, label: `${stops} stops` };
  }

  const ndForm = v.match(/^nd\s*([+-]?\d*\.?\d+)$/i);
  const xForm = v.match(/^([+-]?\d*\.?\d+)\s*x$/i);
  const factorRaw = ndForm ? ndForm[1] : xForm ? xForm[1] : null;
  if (factorRaw !== null) {
    const factor = Number(factorRaw);
    if (factor < 1) {
      throw new ToolError(
        "impossible",
        `An ND factor of ${factor} would brighten the scene.`,
        "Use a filter factor of 1 or more, like ND8 or ND1000.",
      );
    }
    return { stops: Math.log2(factor), label: `ND${factorRaw}` };
  }

  const bare = v.match(/^([+-]?\d*\.?\d+)$/);
  if (bare) {
    const num = Number(bare[1]);
    if (bare[1].includes(".")) {
      if (num < 0) {
        throw new ToolError(
          "impossible",
          `An optical density of ${num} is not a filter.`,
          "Optical density runs from about 0.3 (one stop) to 4.5 (fifteen stops).",
        );
      }
      return { stops: num / 0.3, label: `density ${bare[1]}` };
    }
    if (num < 1) {
      throw new ToolError(
        "impossible",
        `An ND factor of ${num} would brighten the scene.`,
        "Use a filter factor of 1 or more, like ND8 or ND1000.",
      );
    }
    return { stops: Math.log2(num), label: `ND${bare[1]}` };
  }

  throw badToken(
    token,
    `Could not read "${value}" as an ND strength`,
    'Write it as "ND1000", "1000x", "10 stops", or the optical density "3.0".',
  );
}

function parsePlainNumber(value: string, token: string, what: string): number {
  const m = value.match(/^([+-]?\d*\.?\d+)$/);
  if (!m) {
    throw badToken(token, `Could not read "${value}" as ${what}`, `Write ${what} as a plain number.`);
  }
  return Number(m[1]);
}

/** Look for the mode before anything else, since it decides how bare tokens read. */
function detectMode(tokens: string[], fallback: Mode): { mode: Mode; consumed: Set<number> } {
  const consumed = new Set<number>();
  let mode: Mode | null = null;
  tokens.forEach((token, i) => {
    const eq = token.indexOf("=");
    if (eq > 0) {
      const key = KEY_MAP[normalizeKey(token.slice(0, eq))];
      if (key === "mode") {
        const found = MODE_ALIASES[normalizeKey(token.slice(eq + 1))];
        if (!found) {
          throw badToken(
            token,
            `Unknown mode "${token.slice(eq + 1)}"`,
            "Use dof, hyperfocal, exposure, nd, or fov.",
          );
        }
        mode = found;
        consumed.add(i);
      }
      return;
    }
    const alias = MODE_ALIASES[normalizeKey(token)];
    if (alias && mode === null) {
      mode = alias;
      consumed.add(i);
    }
  });
  return { mode: mode ?? fallback, consumed };
}

function parseInput(input: string, fallbackMode: Mode): Parsed {
  const raw = (input ?? "").trim();
  if (!raw) {
    throw new ToolError(
      "empty-input",
      "Enter the numbers to calculate with.",
      'Try "50mm f/2.8 3m" for depth of field, "f/16 1/125 ISO100" for exposure, or "1/125 ND1000" for an ND filter.',
    );
  }

  const tokens = normalizeInput(raw).split(/[\s,;]+/).filter(Boolean);
  const { mode, consumed } = detectMode(tokens, fallbackMode);
  const out: Parsed = { mode, imperial: false };

  /** Bare plain numbers fill these fields in order, per mode. */
  const positional: Record<Mode, FieldKey[]> = {
    dof: ["focal", "aperture", "distance"],
    hyperfocal: ["focal", "aperture"],
    exposure: [],
    nd: ["nd"],
    fov: ["focal", "distance"],
  };
  const queue = [...positional[mode]];

  /** A field set explicitly can no longer be filled by a later bare number. */
  const claim = (key: FieldKey): void => {
    const at = queue.indexOf(key);
    if (at >= 0) queue.splice(at, 1);
  };

  const assign = (key: FieldKey, value: string, token: string): void => {
    claim(key);
    switch (key) {
      case "focal":
        out.focal = parseFocal(value, token);
        return;
      case "aperture":
        out.aperture = parseAperture(value, token);
        return;
      case "distance": {
        const d = parseDistance(value, token);
        out.distance = d.mm;
        if (d.imperial) out.imperial = true;
        return;
      }
      case "shutter":
        out.shutter = parseShutter(value, token);
        return;
      case "iso":
        out.iso = parseIso(value, token);
        return;
      case "ev":
        out.ev = parsePlainNumber(value, token, "an exposure value");
        return;
      case "nd": {
        const nd = parseNd(value, token);
        out.ndStops = nd.stops;
        out.ndLabel = nd.label;
        return;
      }
      case "target":
        out.target = parseShutter(value, token);
        return;
      case "sensorWidth":
        out.sensorWidth = parsePlainNumber(value, token, "a sensor width in mm");
        return;
      case "sensorHeight":
        out.sensorHeight = parsePlainNumber(value, token, "a sensor height in mm");
        return;
      case "coc":
        out.coc = parsePlainNumber(value, token, "a circle of confusion in mm");
        return;
      case "sensor": {
        const id = SENSOR_ALIASES[normalizeKey(value)];
        if (!id) {
          throw badToken(
            token,
            `Unknown sensor "${value}"`,
            "Use full-frame, aps-c, aps-c-canon, micro-four-thirds, 1-inch, medium-format-44x33, or custom.",
          );
        }
        out.sensorId = id;
        return;
      }
      case "mode":
        return;
    }
  };

  tokens.forEach((token, i) => {
    if (consumed.has(i)) return;

    const eq = token.indexOf("=");
    if (eq > 0) {
      const keyRaw = token.slice(0, eq);
      const key = KEY_MAP[normalizeKey(keyRaw)];
      if (!key) {
        throw badToken(
          token,
          `Unrecognized key "${keyRaw}"`,
          "Use keys like focal, aperture, distance, shutter, iso, ev, nd, sensor, or coc.",
        );
      }
      const value = token.slice(eq + 1);
      if (value === "") {
        throw badToken(token, `"${keyRaw}" has no value`, `Write it as ${keyRaw}=<value>.`);
      }
      // "f=50mm" means focal length; "f=2.8" means the f-number.
      if (key === "aperture" && /mm$/i.test(value)) {
        out.focal = parseFocal(value, token);
        return;
      }
      assign(key, value, token);
      return;
    }

    // Bare tokens: the shape of the token decides the field. A token that is
    // simply a number plus a unit ("35mm", "1in") is a measurement, never the
    // sensor whose alias happens to spell the same way.
    const sensorAlias = SENSOR_ALIASES[normalizeKey(token)];
    if (sensorAlias && !/^\d*\.?\d+\s*(mm|cm|km|m|ft|in|s|x|"|')?$/i.test(token)) {
      out.sensorId = sensorAlias;
      return;
    }
    if (/^\d*\.?\d+\s*mm$/i.test(token)) {
      claim("focal");
      out.focal = parseFocal(token, token);
      return;
    }
    if (/^f\/?\d*\.?\d+$/i.test(token)) {
      claim("aperture");
      out.aperture = parseAperture(token, token);
      return;
    }
    if (
      /^nd\s*\d*\.?\d+$/i.test(token) ||
      /^\d*\.?\d+x$/i.test(token) ||
      /^\d*\.?\d+stops?$/i.test(token)
    ) {
      claim("nd");
      const nd = parseNd(token, token);
      out.ndStops = nd.stops;
      out.ndLabel = nd.label;
      return;
    }
    if (/^iso\s*\d*\.?\d+$/i.test(token)) {
      claim("iso");
      out.iso = parseIso(token, token);
      return;
    }
    if (
      /^\d*\.?\d+\s*\/\s*\d*\.?\d+\s*(seconds?|secs?|sec|s|")?$/i.test(token) ||
      /^\d*\.?\d+\s*(seconds?|secs?|sec|s|")$/i.test(token)
    ) {
      claim("shutter");
      out.shutter = parseShutter(token, token);
      return;
    }
    if (/^\d*\.?\d+\s*[a-z'"]+$/i.test(token)) {
      claim("distance");
      const d = parseDistance(token, token);
      out.distance = d.mm;
      if (d.imperial) out.imperial = true;
      return;
    }
    if (/^\d*\.?\d+$/.test(token)) {
      if (mode === "exposure") {
        const num = Number(token);
        if (num < 1) {
          out.shutter = num;
          return;
        }
        if (Number.isInteger(num) && num >= 25) {
          out.iso = num;
          return;
        }
        throw badToken(
          token,
          `"${token}" could be a shutter speed or an ISO`,
          'Say which one, like shutter=0.004 or iso=100, or write the shutter as a fraction such as "1/250".',
        );
      }
      const next = queue.shift();
      if (!next) {
        throw badToken(
          token,
          `Nothing left for the bare number "${token}" to fill`,
          "Label the value, for example distance=3m or coc=0.02.",
        );
      }
      assign(next, token, token);
      return;
    }

    throw badToken(
      token,
      `Could not read "${token}"`,
      'Write values as "50mm f/2.8 3m" or as key=value pairs like focal=50 aperture=2.8 distance=3m.',
    );
  });

  return out;
}

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

function requirePositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ToolError(
      "impossible",
      `${name} must be greater than zero, got ${value}.`,
      `Enter a positive ${name}.`,
    );
  }
}

function requireFields(mode: Mode, missing: string[], example: string): void {
  if (missing.length === 0) return;
  const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
  throw new ToolError(
    "missing-values",
    `${MODE_LABEL[mode]} needs ${list}.`,
    `Try "${example}".`,
  );
}

interface ResolvedSensor {
  label: string;
  width: number;
  height: number;
  coc: number;
}

function resolveSensor(parsed: Parsed, optSensor: string | undefined): ResolvedSensor {
  const requested = parsed.sensorId ?? (optSensor ? SENSOR_ALIASES[normalizeKey(optSensor)] : undefined);
  if (optSensor && !parsed.sensorId && !requested) {
    throw badToken(
      optSensor,
      `Unknown sensor "${optSensor}"`,
      "Use full-frame, aps-c, aps-c-canon, micro-four-thirds, 1-inch, medium-format-44x33, or custom.",
    );
  }
  const id = requested ?? "full-frame";

  if (id === "custom") {
    const missing: string[] = [];
    if (parsed.sensorWidth === undefined) missing.push("sensorWidth");
    if (parsed.sensorHeight === undefined) missing.push("sensorHeight");
    if (missing.length > 0) {
      throw new ToolError(
        "missing-values",
        `A custom sensor needs ${missing.join(" and ")} in millimetres.`,
        'Try "sensor=custom sensorWidth=36 sensorHeight=24 coc=0.03".',
      );
    }
    const width = parsed.sensorWidth as number;
    const height = parsed.sensorHeight as number;
    requirePositive("sensorWidth", width);
    requirePositive("sensorHeight", height);
    const diagonal = Math.hypot(width, height);
    const coc = parsed.coc ?? Math.round((diagonal / 1440) * 1000) / 1000;
    requirePositive("coc", coc);
    return {
      label: `Custom (${width} x ${height} mm)`,
      width,
      height,
      coc,
    };
  }

  const spec = SENSORS.find((s) => s.id === id);
  if (!spec) {
    throw badToken(
      id,
      `Unknown sensor "${id}"`,
      "Use full-frame, aps-c, aps-c-canon, micro-four-thirds, 1-inch, medium-format-44x33, or custom.",
    );
  }
  const coc = parsed.coc ?? spec.coc;
  requirePositive("coc", coc);
  const width = parsed.sensorWidth ?? spec.width;
  const height = parsed.sensorHeight ?? spec.height;
  return { label: spec.label, width, height, coc };
}

/** Hyperfocal distance in mm. */
function hyperfocal(focal: number, aperture: number, coc: number): number {
  return (focal * focal) / (aperture * coc) + focal;
}

// ---------------------------------------------------------------------------
// Mode: dof
// ---------------------------------------------------------------------------

function runDof(parsed: Parsed, sensor: ResolvedSensor): PhotographyCalculatorResult {
  const missing: string[] = [];
  if (parsed.focal === undefined) missing.push("a focal length");
  if (parsed.aperture === undefined) missing.push("an aperture");
  if (parsed.distance === undefined) missing.push("a subject distance");
  requireFields("dof", missing, "50mm f/2.8 3m");

  const f = parsed.focal as number;
  const N = parsed.aperture as number;
  const s = parsed.distance as number;
  requirePositive("focal length", f);
  requirePositive("aperture", N);
  requirePositive("subject distance", s);

  if (s <= f) {
    throw new ToolError(
      "impossible",
      `The subject distance (${formatDistance(s, parsed.imperial)}) is not greater than the focal length (${f} mm), so the lens cannot focus there.`,
      "Focus further away than the focal length of the lens.",
    );
  }

  const H = hyperfocal(f, N, sensor.coc);
  const near = (s * (H - f)) / (H + s - 2 * f);
  const far = s >= H ? Infinity : (s * (H - f)) / (H - s);
  const total = far - near;
  const front = s - near;
  const behind = far - s;
  const magnification = f / (s - f);

  const out: PhotographyCalculatorResult = {
    "Hyperfocal distance": formatDistance(H, parsed.imperial),
    "Near limit": formatDistance(near, parsed.imperial),
    "Far limit": formatDistance(far, parsed.imperial),
    "Total depth of field": formatDistance(total, parsed.imperial),
  };

  if (Number.isFinite(total)) {
    out["In front of subject"] = `${formatDistance(front, parsed.imperial)} (${((front / total) * 100).toFixed(1)}%)`;
    out["Behind subject"] = `${formatDistance(behind, parsed.imperial)} (${((behind / total) * 100).toFixed(1)}%)`;
  } else {
    out["In front of subject"] = formatDistance(front, parsed.imperial);
    out["Behind subject"] = "infinity";
    out["Focus note"] =
      "The subject is at or past the hyperfocal distance, so everything from the near limit to the horizon is acceptably sharp.";
  }

  out.Magnification = `${magnification.toFixed(4)}x (1:${(1 / magnification).toFixed(1)})`;
  out.Setup = `${f} mm at ${formatAperture(N)}, focused at ${formatDistance(s, parsed.imperial)}`;
  out.Sensor = sensor.label;
  out["Circle of confusion"] = `${sensor.coc} mm`;
  out["Acceptable sharpness"] =
    `Sharpness here means a blur circle no larger than ${sensor.coc} mm on the sensor, the usual standard for an 8 by 10 inch print seen from about 25 cm. Viewing at 100% on a high resolution screen is stricter, so pass a smaller value such as coc=0.015 for a conservative answer.`;
  out.Formula = "H = f^2 / (N x c) + f; near = s(H - f) / (H + s - 2f); far = s(H - f) / (H - s)";
  return out;
}

// ---------------------------------------------------------------------------
// Mode: hyperfocal
// ---------------------------------------------------------------------------

const HYPERFOCAL_TABLE_APERTURES = [2.8, 4, 5.6, 8, 11, 16];

function runHyperfocal(parsed: Parsed, sensor: ResolvedSensor): PhotographyCalculatorResult {
  const missing: string[] = [];
  if (parsed.focal === undefined) missing.push("a focal length");
  if (parsed.aperture === undefined) missing.push("an aperture");
  requireFields("hyperfocal", missing, "35mm f/8");

  const f = parsed.focal as number;
  const N = parsed.aperture as number;
  requirePositive("focal length", f);
  requirePositive("aperture", N);

  const H = hyperfocal(f, N, sensor.coc);

  const out: PhotographyCalculatorResult = {
    "Hyperfocal distance": formatDistance(H, parsed.imperial),
    "Near limit at hyperfocal focus": formatDistance(H / 2, parsed.imperial),
    "Far limit at hyperfocal focus": "infinity",
    Setup: `${f} mm at ${formatAperture(N)}`,
    Sensor: sensor.label,
    "Circle of confusion": `${sensor.coc} mm`,
  };

  for (const a of HYPERFOCAL_TABLE_APERTURES) {
    const h = hyperfocal(f, a, sensor.coc);
    out[formatAperture(a)] =
      `${formatDistance(h, parsed.imperial)} (sharp from ${formatDistance(h / 2, parsed.imperial)} to infinity)`;
  }

  out.Formula = "H = f^2 / (N x c) + f; focusing at H puts H/2 to infinity in focus";
  out.Note =
    `Focus at ${formatDistance(H, parsed.imperial)} and everything from ${formatDistance(H / 2, parsed.imperial)} to the horizon falls inside the depth of field. Focusing past that point buys nothing at the far end and gives up near sharpness.`;
  return out;
}

// ---------------------------------------------------------------------------
// Mode: exposure
// ---------------------------------------------------------------------------

function equivalentExposures(baseAperture: number, baseShutter: number): string {
  const baseStops = 2 * Math.log2(baseAperture);
  let baseIndex = 0;
  let bestErr = Infinity;
  FULL_STOP_APERTURES.forEach((a, i) => {
    const err = Math.abs(2 * Math.log2(a) - baseStops);
    if (err < bestErr) {
      bestErr = err;
      baseIndex = i;
    }
  });
  const windowSize = 6;
  const start = Math.min(
    Math.max(baseIndex - 2, 0),
    Math.max(FULL_STOP_APERTURES.length - windowSize, 0),
  );
  const picks = FULL_STOP_APERTURES.slice(start, start + windowSize);

  return picks
    .map((a, i) => {
      const stopNumber = start + i + 1;
      const t = baseShutter * 2 ** (stopNumber - baseStops);
      return `${formatAperture(a)} ${formatShutter(t)}`;
    })
    .join(", ");
}

function runExposure(parsed: Parsed): PhotographyCalculatorResult {
  const out: PhotographyCalculatorResult = {};
  const notes: string[] = [];

  let { aperture, shutter, iso } = parsed;
  const ev = parsed.ev;

  if (aperture !== undefined) requirePositive("aperture", aperture);
  if (shutter !== undefined) requirePositive("shutter speed", shutter);
  if (iso !== undefined) requirePositive("ISO", iso);

  let ev100: number;

  if (ev !== undefined) {
    ev100 = ev;
    if (aperture === undefined && shutter === undefined) {
      requireFields("exposure", ["an aperture or a shutter speed to go with ev"], "ev=15 f/16");
    }
    if (aperture === undefined) {
      const isoUsed = iso ?? 100;
      if (iso === undefined) notes.push("No ISO given, so ISO 100 was assumed.");
      iso = isoUsed;
      aperture = Math.sqrt((shutter as number) * 2 ** ev100 * (isoUsed / 100));
      notes.push("Aperture solved from the exposure value.");
    } else if (shutter === undefined) {
      const isoUsed = iso ?? 100;
      if (iso === undefined) notes.push("No ISO given, so ISO 100 was assumed.");
      iso = isoUsed;
      shutter = (aperture * aperture * 100) / (isoUsed * 2 ** ev100);
      notes.push(
        "Shutter speed solved from the exposure value, then shown at the nearest marked speed.",
      );
    } else if (iso === undefined) {
      iso = (100 * ((aperture * aperture) / shutter)) / 2 ** ev100;
      notes.push("ISO solved from the exposure value.");
    } else {
      const measured =
        Math.log2((aperture * aperture) / shutter) - Math.log2(iso / 100);
      notes.push(
        `Aperture, shutter, and ISO were all given: they measure EV ${measured.toFixed(2)}, which is ${formatStopsDelta(measured - ev100)} the EV ${ev100} you asked for.`,
      );
    }
  } else {
    const missing: string[] = [];
    if (aperture === undefined) missing.push("an aperture");
    if (shutter === undefined) missing.push("a shutter speed");
    requireFields("exposure", missing, "f/16 1/125 ISO100");
    if (iso === undefined) {
      iso = 100;
      notes.push("No ISO given, so ISO 100 was assumed.");
    }
    ev100 = Math.log2((aperture as number) ** 2 / (shutter as number)) - Math.log2(iso / 100);
  }

  const N = aperture as number;
  const t = shutter as number;
  const isoUsed = iso as number;
  requirePositive("aperture", N);
  requirePositive("shutter speed", t);
  requirePositive("ISO", isoUsed);

  out.Aperture = formatAperture(Math.round(N * 10) / 10);
  out.Shutter = formatShutter(t);
  out.ISO = `ISO ${Math.round(isoUsed)}`;
  out["EV at ISO 100"] = ev100.toFixed(2);
  if (Math.abs(isoUsed - 100) > 0.5) {
    out[`EV at ISO ${Math.round(isoUsed)}`] = (ev100 + Math.log2(isoUsed / 100)).toFixed(2);
  }

  const scene = EV_SCENES[Math.round(ev100)] ?? "an unusual light level";
  out["Lighting reference"] =
    `Sunny 16 is EV 15 at ISO 100 (bright sun, f/16, 1/100 s). This exposure sits ${formatStopsDelta(ev100 - 15)} sunny 16, about the light of ${scene}.`;

  out["Equivalent exposures"] = equivalentExposures(N, t);

  if (parsed.target !== undefined) {
    requirePositive("target shutter speed", parsed.target);
    const neededIso = (100 * ((N * N) / parsed.target)) / 2 ** ev100;
    const standard = nearestStandardIso(neededIso);
    out[`ISO for ${formatShutter(parsed.target)} at ${formatAperture(Math.round(N * 10) / 10)}`] =
      `ISO ${Math.round(neededIso)} (nearest full stop setting: ISO ${standard})`;
  }

  out.Formula = "EV100 = log2(N^2 / t) - log2(ISO / 100)";
  if (notes.length > 0) out.Assumptions = notes.join(" ");
  return out;
}

// ---------------------------------------------------------------------------
// Mode: nd
// ---------------------------------------------------------------------------

function ndRowValue(seconds: number, stops: number): string {
  const suffix = seconds > 30 ? ", use bulb mode" : "";
  return `${stops.toFixed(1)} stops, ${formatShutter(seconds)}${suffix}`;
}

function runNd(parsed: Parsed): PhotographyCalculatorResult {
  const missing: string[] = [];
  if (parsed.shutter === undefined) missing.push("a base shutter speed");
  if (parsed.ndStops === undefined) missing.push("an ND strength");
  requireFields("nd", missing, "1/125 ND1000");

  const base = parsed.shutter as number;
  const stops = parsed.ndStops as number;
  requirePositive("base shutter speed", base);
  if (!Number.isFinite(stops) || stops < 0) {
    throw new ToolError(
      "impossible",
      `An ND filter cannot remove ${stops} stops of light.`,
      "Use a strength of zero stops or more, like ND8, 3 stops, or the density 0.9.",
    );
  }

  const factor = 2 ** stops;
  const newTime = base * factor;

  const out: PhotographyCalculatorResult = {
    "Base shutter": formatShutter(base),
    "ND filter": `${parsed.ndLabel ?? `${stops.toFixed(1)} stops`} (${stops.toFixed(1)} stops, factor ${factor >= 100 ? Math.round(factor) : factor.toFixed(1)}x, density ${(stops * 0.3).toFixed(1)})`,
    "New shutter": formatShutter(newTime),
  };

  if (newTime > 30) {
    out["Bulb mode"] = `${formatShutter(newTime)} is longer than the 30 s most cameras offer, so use bulb with a remote or an intervalometer.`;
  }

  for (const f of COMMON_NDS) {
    out[`ND${f}`] = ndRowValue(base * f, Math.log2(f));
  }

  out.Formula = "new time = base time x filter factor; stops = log2(factor); density = stops x 0.3";
  out.Note =
    "Times over one second are rounded to the nearest half second, which is finer than any shutter dial. Very dense filters also shift colour and can add a few percent of extra exposure, so bracket long exposures.";
  return out;
}

// ---------------------------------------------------------------------------
// Mode: fov
// ---------------------------------------------------------------------------

function angleOfView(dimension: number, focal: number): number {
  return (2 * Math.atan(dimension / (2 * focal)) * 180) / Math.PI;
}

function runFov(parsed: Parsed, sensor: ResolvedSensor): PhotographyCalculatorResult {
  if (parsed.focal === undefined) {
    requireFields("fov", ["a focal length"], "24mm");
  }
  const f = parsed.focal as number;
  requirePositive("focal length", f);

  const diagonal = Math.hypot(sensor.width, sensor.height);
  const fullFrame = SENSORS[0];
  const fullFrameDiagonal = Math.hypot(fullFrame.width, fullFrame.height);
  const crop = fullFrameDiagonal / diagonal;

  const out: PhotographyCalculatorResult = {
    "Horizontal angle of view": `${angleOfView(sensor.width, f).toFixed(1)} deg`,
    "Vertical angle of view": `${angleOfView(sensor.height, f).toFixed(1)} deg`,
    "Diagonal angle of view": `${angleOfView(diagonal, f).toFixed(1)} deg`,
    "Crop factor": `${crop.toFixed(2)}x`,
    "35mm equivalent focal length": `${(f * crop).toFixed(1)} mm`,
    Setup: `${f} mm lens`,
    Sensor: sensor.label,
    "Sensor diagonal": `${diagonal.toFixed(2)} mm`,
  };

  if (parsed.distance !== undefined) {
    const d = parsed.distance;
    requirePositive("subject distance", d);
    if (d <= f) {
      throw new ToolError(
        "impossible",
        `The subject distance (${formatDistance(d, parsed.imperial)}) is not greater than the focal length (${f} mm), so the lens cannot focus there.`,
        "Use a subject distance larger than the focal length.",
      );
    }
    const width = (d * sensor.width) / f;
    const height = (d * sensor.height) / f;
    const label = formatDistance(d, parsed.imperial);
    out[`Frame width at ${label}`] = formatDistance(width, parsed.imperial);
    out[`Frame height at ${label}`] = formatDistance(height, parsed.imperial);
    out[`Frame diagonal at ${label}`] = formatDistance(Math.hypot(width, height), parsed.imperial);
  }

  out.Formula = "angle = 2 x atan(sensor dimension / (2 x focal length)); crop = 43.27 mm / sensor diagonal";
  out.Note =
    "Angles are the geometric field of a rectilinear lens focused at infinity. Real lenses breathe a little at close focus, and fisheye projections do not follow this formula at all.";
  return out;
}

// ---------------------------------------------------------------------------

export function run(
  input: string,
  opts: PhotographyCalculatorOpts = {},
): PhotographyCalculatorResult {
  const optMode = opts.mode ? MODE_ALIASES[normalizeKey(opts.mode)] : undefined;
  if (opts.mode && !optMode) {
    throw badToken(
      opts.mode,
      `Unknown mode "${opts.mode}"`,
      "Use dof, hyperfocal, exposure, nd, or fov.",
    );
  }

  const parsed = parseInput(input, optMode ?? "dof");
  const mode = parsed.mode ?? optMode ?? "dof";

  if (mode === "exposure") return runExposure(parsed);
  if (mode === "nd") return runNd(parsed);

  const sensor = resolveSensor(parsed, opts.sensor as string | undefined);
  if (mode === "hyperfocal") return runHyperfocal(parsed, sensor);
  if (mode === "fov") return runFov(parsed, sensor);
  return runDof(parsed, sensor);
}

export default { run } satisfies ToolLogic<
  string,
  PhotographyCalculatorResult,
  PhotographyCalculatorOpts
>;

// Exported for tests only; not part of the tool's public logic surface.
export const __test__ = { formatShutter, formatDistance, hyperfocal, SENSORS };
