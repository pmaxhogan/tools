import { ToolError, type ToolLogic } from "../types";

export interface FresnelZoneOpts {
  /** Effective earth radius factor for earth bulge: "4/3" (standard) or "1" (no correction). */
  kFactor: string;
  [key: string]: unknown;
}

export type FresnelZoneResult = Record<string, string>;

const C = 299792458; // m/s, exact
const EARTH_RADIUS_M = 6371000;

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

const NUMBER_UNIT_JOIN = /(\d+(?:\.\d+)?)\s+(GHz|MHz|kHz|Hz|km|mi|ft|m)\b/gi;

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
      'Use a number followed by Hz, kHz, MHz, or GHz, like "5.8GHz".',
    );
  }
  return bare * 1e6;
}

function parseDistanceM(raw: string, label = "distance"): number {
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
      `Use a number followed by m, km, ft, or mi, like "5 km".`,
    );
  }
  return bare * 1000;
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

/** First Fresnel zone radius, meters, at distance d1 from one end of a total path length d (all in meters). */
function fresnelRadiusM(d1: number, d2: number, wavelengthM: number): number {
  return Math.sqrt((wavelengthM * d1 * d2) / (d1 + d2));
}

/** Earth bulge height, meters, at a point d1 from one end of a total link of length d, with effective earth radius k*R. */
function earthBulgeM(d1: number, d2: number, kEffectiveRadiusM: number): number {
  return (d1 * d2) / (2 * kEffectiveRadiusM);
}

function formatLength(m: number): string {
  const ft = m / 0.3048;
  const decimals = Math.abs(m) >= 10 ? 2 : Math.abs(m) >= 1 ? 3 : 4;
  return `${m.toFixed(decimals)} m (${ft.toFixed(decimals)} ft)`;
}

interface Fields {
  freqHz?: number;
  totalDistM?: number;
  obstacleDistM?: number;
  obstacleHeightM?: number;
}

const KEY_FIELD: Record<string, keyof Fields> = {
  freq: "freqHz",
  frequency: "freqHz",
  f: "freqHz",
  distance: "totalDistM",
  dist: "totalDistM",
  d: "totalDistM",
  range: "totalDistM",
  obstacle: "obstacleDistM",
  obstacledistance: "obstacleDistM",
  obstacledist: "obstacleDistM",
  od: "obstacleDistM",
  obstacleheight: "obstacleHeightM",
  height: "obstacleHeightM",
  oh: "obstacleHeightM",
};

const FIELD_LABEL: Record<keyof Fields, string> = {
  freqHz: "frequency",
  totalDistM: "link distance",
  obstacleDistM: "obstacle distance",
  obstacleHeightM: "obstacle height",
};

function parseInput(raw: string): Fields {
  const s = (raw ?? "").trim();
  if (!s) {
    throw new ToolError(
      "empty-input",
      'Enter a frequency and a link distance, like "5.8GHz 10km".',
      'Try "5.8GHz 10km" or "freq=5.8GHz distance=10km obstacle=4km obstacleheight=15m".',
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
      const field = KEY_FIELD[key];
      if (!field) {
        throw new ToolError(
          "bad-token",
          `Unrecognized key "${key}" in "${token}".`,
          "Use freq, distance, obstacle (distance from the start), or obstacleheight.",
        );
      }
      if (field === "freqHz") fields.freqHz = parseFrequencyHz(val);
      else fields[field] = parseDistanceM(val, FIELD_LABEL[field]);
      continue;
    }
    if (/^[\d.]+(ghz|mhz|khz|hz)$/i.test(token)) {
      if (fields.freqHz === undefined) fields.freqHz = parseFrequencyHz(token);
      continue;
    }
    if (/^[\d.]+(km|mi|ft|m)$/i.test(token)) {
      if (fields.totalDistM === undefined) fields.totalDistM = parseDistanceM(token);
      continue;
    }
  }
  return fields;
}

export function run(input: string, opts: FresnelZoneOpts): FresnelZoneResult {
  const fields = parseInput(input);
  if (fields.freqHz === undefined) {
    throw new ToolError(
      "missing-frequency",
      "No frequency found in the input.",
      'Add a frequency like "5.8GHz" or "freq=5.8GHz".',
    );
  }
  if (fields.totalDistM === undefined) {
    throw new ToolError(
      "missing-distance",
      "No link distance found in the input.",
      'Add a distance like "10km" or "distance=10km".',
    );
  }
  assertPositive("frequency", fields.freqHz);
  assertPositive("link distance", fields.totalDistM);

  const wavelengthM = C / fields.freqHz;
  const totalDistM = fields.totalDistM;
  const kFactor = opts.kFactor === "1" ? 1 : 4 / 3;
  const effectiveRadiusM = kFactor * EARTH_RADIUS_M;

  const out: FresnelZoneResult = {};
  out["Frequency"] = `${(fields.freqHz / 1e6).toFixed(4)} MHz`;
  out["Wavelength"] = `${(wavelengthM * 100).toFixed(2)} cm`;
  out["Link distance"] = formatLength(totalDistM);

  const midD1 = totalDistM / 2;
  const midRadius = fresnelRadiusM(midD1, midD1, wavelengthM);
  const midBulge = earthBulgeM(midD1, midD1, effectiveRadiusM);
  out["First Fresnel zone radius at midpoint"] = formatLength(midRadius);
  out["60% clearance target at midpoint"] = formatLength(midRadius * 0.6);
  out["Earth bulge at midpoint"] = `${formatLength(midBulge)} (k = ${kFactor === 1 ? "1" : "4/3"})`;
  out["Recommended clearance above line of sight at midpoint"] = formatLength(
    midRadius * 0.6 + midBulge,
  );
  out["Formula"] =
    "r = sqrt(wavelength x d1 x d2 / (d1 + d2)); bulge = d1 x d2 / (2 x k x earth radius)";

  if (fields.obstacleDistM !== undefined) {
    if (fields.obstacleDistM <= 0 || fields.obstacleDistM >= totalDistM) {
      throw new ToolError(
        "impossible",
        `The obstacle distance (${formatLength(fields.obstacleDistM)}) must be between 0 and the link distance (${formatLength(totalDistM)}).`,
        "Give an obstacle distance strictly between the two ends of the link.",
      );
    }
    const d1 = fields.obstacleDistM;
    const d2 = totalDistM - d1;
    const obsRadius = fresnelRadiusM(d1, d2, wavelengthM);
    const obsBulge = earthBulgeM(d1, d2, effectiveRadiusM);
    out["First Fresnel zone radius at obstacle"] = formatLength(obsRadius);
    out["60% clearance target at obstacle"] = formatLength(obsRadius * 0.6);
    out["Earth bulge at obstacle"] = formatLength(obsBulge);
    const requiredClearance = obsRadius * 0.6 + obsBulge;
    out["Required clearance above the obstacle top"] = formatLength(requiredClearance);

    if (fields.obstacleHeightM !== undefined) {
      const requiredAntennaHeight = fields.obstacleHeightM + requiredClearance;
      out["Obstacle height"] = formatLength(fields.obstacleHeightM);
      out["Recommended antenna height at the obstacle"] = formatLength(requiredAntennaHeight);
      out["Note"] =
        "Recommended antenna height is a straight line drawn through this height at the obstacle point; the actual mast height needed at each tower end depends on the terrain profile and the antenna's height above ground at the near end.";
    }
  }

  return out;
}

export default { run } satisfies ToolLogic<string, FresnelZoneResult, FresnelZoneOpts>;

// Exported for tests only; not part of the tool's public logic surface.
export const __test__ = {
  parseFrequencyHz,
  parseDistanceM,
  fresnelRadiusM,
  earthBulgeM,
  parseInput,
};
