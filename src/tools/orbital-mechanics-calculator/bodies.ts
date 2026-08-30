/**
 * Gravitational parameters, radii and rotation periods for the bodies the
 * orbital mechanics calculator offers as presets.
 *
 * Pure data plus one lookup helper. Values are the standard published
 * constants:
 *
 * - GM (the gravitational parameter, in km^3/s^2) for the Sun and the
 *   planets: the JPL Solar System Dynamics planetary physical parameters
 *   table, which reports the planet system values used for ephemerides.
 *   The Moon, Ceres and Pluto are the body values from the same source.
 * - Mean and equatorial radii: the IAU Working Group on Cartographic
 *   Coordinates and Rotational Elements report.
 * - Sidereal rotation periods: the same IAU report, except Saturn, where
 *   the 10h 33m 38s figure is the 2019 result derived from Cassini ring
 *   seismology rather than the older System III radio period.
 *
 * Two radii are kept per body on purpose. Escape velocity from "the
 * surface" is conventionally quoted against the mean radius, while a
 * synchronous orbit sits over the equator and its altitude is
 * conventionally quoted against the equatorial radius. Using one radius
 * for both would make one of the two famous numbers wrong.
 */

export interface BodyPreset {
  /** Display name. */
  name: string;
  /** Gravitational parameter GM, in km^3/s^2. */
  mu: number;
  /** Mean (volumetric) radius in km. */
  meanRadius: number;
  /** Equatorial radius in km. */
  equatorialRadius: number;
  /** Sidereal rotation period in seconds, always positive. */
  rotationSeconds: number;
  /** True when the body turns backwards relative to its orbit. */
  retrograde?: boolean;
  /** Extra search aliases. */
  aliases?: readonly string[];
}

const RAW: readonly BodyPreset[] = [
  {
    name: "Sun",
    mu: 132712440018,
    meanRadius: 695700,
    equatorialRadius: 695700,
    rotationSeconds: 2192832,
    aliases: ["sol", "star"],
  },
  {
    name: "Mercury",
    mu: 22031.86855,
    meanRadius: 2439.7,
    equatorialRadius: 2440.53,
    rotationSeconds: 5067031.68,
  },
  {
    name: "Venus",
    mu: 324858.592,
    meanRadius: 6051.8,
    equatorialRadius: 6051.8,
    rotationSeconds: 20996798.4,
    retrograde: true,
  },
  {
    name: "Earth",
    mu: 398600.4418,
    meanRadius: 6371.0084,
    equatorialRadius: 6378.137,
    rotationSeconds: 86164.0905,
    aliases: ["terra", "home"],
  },
  {
    name: "Moon",
    mu: 4902.800118,
    meanRadius: 1737.4,
    equatorialRadius: 1738.1,
    rotationSeconds: 2360591.5,
    aliases: ["luna"],
  },
  {
    name: "Mars",
    mu: 42828.375214,
    meanRadius: 3389.5,
    equatorialRadius: 3396.19,
    rotationSeconds: 88642.663,
    aliases: ["red planet"],
  },
  {
    name: "Ceres",
    mu: 62.6284,
    meanRadius: 469.7,
    equatorialRadius: 482.1,
    rotationSeconds: 32667,
    aliases: ["dwarf planet", "asteroid belt"],
  },
  {
    name: "Jupiter",
    mu: 126686534,
    meanRadius: 69911,
    equatorialRadius: 71492,
    rotationSeconds: 35729.685,
  },
  {
    name: "Saturn",
    mu: 37931187,
    meanRadius: 58232,
    equatorialRadius: 60268,
    rotationSeconds: 38018,
  },
  {
    name: "Uranus",
    mu: 5793939,
    meanRadius: 25362,
    equatorialRadius: 25559,
    rotationSeconds: 62063.712,
    retrograde: true,
  },
  {
    name: "Neptune",
    mu: 6836529,
    meanRadius: 24622,
    equatorialRadius: 24764,
    rotationSeconds: 57996,
  },
  {
    name: "Pluto",
    mu: 869.6,
    meanRadius: 1188.3,
    equatorialRadius: 1188.3,
    rotationSeconds: 551856.7,
    retrograde: true,
    aliases: ["dwarf planet"],
  },
];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]/g, "");
}

const INDEX = new Map<string, BodyPreset>();
for (const body of RAW) {
  INDEX.set(normalize(body.name), body);
  for (const alias of body.aliases ?? []) {
    const key = normalize(alias);
    if (!INDEX.has(key)) INDEX.set(key, body);
  }
}

/** Look up a body by name or alias. Undefined when the name is unknown. */
export function lookupBody(name: string): BodyPreset | undefined {
  return INDEX.get(normalize(name));
}

/** Every preset, in the order they are offered. */
export function allBodies(): readonly BodyPreset[] {
  return RAW;
}

/** The names of every preset, for an error message. */
export const BODY_NAMES = RAW.map((b) => b.name).join(", ");
