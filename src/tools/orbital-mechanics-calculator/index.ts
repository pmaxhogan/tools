/**
 * Orbital mechanics calculator.
 *
 * Two body Keplerian mechanics, which is what almost every mission
 * napkin sketch starts from:
 *
 * - Vis-viva: v^2 = GM (2/r - 1/a). The energy integral of the two body
 *   problem, and the single equation the circular and escape speeds both
 *   fall out of (a = r gives sqrt(GM/r), a infinite gives sqrt(2GM/r)).
 * - Kepler's third law in its Newtonian form: T = 2 pi sqrt(a^3 / GM).
 * - The Hohmann transfer: the minimum energy two burn transfer between
 *   two coplanar circular orbits. W. Hohmann, "Die Erreichbarkeit der
 *   Himmelskorper" (1925).
 * - A simple plane change: dv = 2 v sin(di / 2), the isoceles triangle of
 *   the two velocity vectors.
 *
 * Every result is a two body, impulsive burn, point mass idealization.
 * It ignores atmospheric drag, oblateness, third body pull, finite burn
 * losses and gravity losses on ascent, so real mission numbers run
 * higher. The output says so.
 *
 * Pure arithmetic and string parsing. No DOM, no network, no storage.
 */

import { ToolError, type ToolLogic } from "../types";
import { lookupBody, BODY_NAMES, type BodyPreset } from "./bodies";

const TWO_PI = Math.PI * 2;
const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ */
/* The equations                                                        */
/* ------------------------------------------------------------------ */

/** Circular orbital speed at radius r, in the units mu is given in. */
export function circularSpeed(mu: number, r: number): number {
  return Math.sqrt(mu / r);
}

/** Escape speed at radius r: the circular speed times the square root of 2. */
export function escapeSpeed(mu: number, r: number): number {
  return Math.sqrt((2 * mu) / r);
}

/** Vis-viva: speed at radius r on an orbit of semi-major axis a. */
export function visViva(mu: number, r: number, a: number): number {
  const v2 = mu * (2 / r - 1 / a);
  if (v2 < 0) {
    throw new ToolError(
      "outside-orbit",
      "That radius is outside the orbit, so the object never reaches it.",
      "On an orbit with semi-major axis a and eccentricity e the radius stays between a(1-e) and a(1+e).",
    );
  }
  return Math.sqrt(v2);
}

/** Orbital period from Kepler's third law, in seconds. */
export function orbitalPeriod(mu: number, a: number): number {
  return TWO_PI * Math.sqrt(a ** 3 / mu);
}

/** Semi-major axis that gives a chosen period: the inverse of Kepler 3. */
export function axisForPeriod(mu: number, seconds: number): number {
  return ((mu * seconds * seconds) / (4 * Math.PI * Math.PI)) ** (1 / 3);
}

/** Specific orbital energy, per unit mass. */
export function specificEnergy(mu: number, a: number): number {
  return -mu / (2 * a);
}

/** The delta-v of a simple plane change at speed v, angle in degrees. */
export function planeChangeDeltaV(speed: number, degrees: number): number {
  return 2 * speed * Math.sin((degrees * DEG) / 2);
}

export interface HohmannTransfer {
  /** Semi-major axis of the transfer ellipse. */
  transferAxis: number;
  /** Burn at the starting orbit. Negative when the transfer goes inward. */
  firstBurn: number;
  /** Burn at the destination. Negative when the transfer goes inward. */
  secondBurn: number;
  /** Sum of the two burn magnitudes. */
  totalDeltaV: number;
  /** Half the transfer ellipse's period, in seconds. */
  transferSeconds: number;
  /** Where the destination must be at departure, degrees ahead. */
  phaseAngleDegrees: number;
}

/**
 * The two burn Hohmann transfer between coplanar circular orbits of
 * radius r1 and r2. Burns are signed: positive is prograde, so a
 * transfer down to a lower orbit gives two negative numbers.
 */
export function hohmannTransfer(mu: number, r1: number, r2: number): HohmannTransfer {
  const transferAxis = (r1 + r2) / 2;
  const v1 = circularSpeed(mu, r1);
  const v2 = circularSpeed(mu, r2);
  const vDepart = Math.sqrt(mu * (2 / r1 - 1 / transferAxis));
  const vArrive = Math.sqrt(mu * (2 / r2 - 1 / transferAxis));
  const firstBurn = vDepart - v1;
  const secondBurn = v2 - vArrive;
  const transferSeconds = Math.PI * Math.sqrt(transferAxis ** 3 / mu);
  const targetPeriod = orbitalPeriod(mu, r2);
  const phase = 180 - (360 * transferSeconds) / targetPeriod;
  return {
    transferAxis,
    firstBurn,
    secondBurn,
    totalDeltaV: Math.abs(firstBurn) + Math.abs(secondBurn),
    transferSeconds,
    phaseAngleDegrees: ((phase % 360) + 360) % 360,
  };
}

/* ------------------------------------------------------------------ */
/* Unit parsing                                                         */
/* ------------------------------------------------------------------ */

/** Kilometers in one astronomical unit (IAU 2012 definition, exact). */
export const AU_IN_KM = 149597870.7;

/** Length units, keyed by lower cased spelling, valued in kilometers. */
const LENGTH_UNITS: Record<string, number | undefined> = {
  km: 1,
  kilometer: 1,
  kilometers: 1,
  kilometre: 1, // spelling: allow (accepted input synonym)
  kilometres: 1, // spelling: allow (accepted input synonym)
  m: 0.001,
  meter: 0.001,
  meters: 0.001,
  metre: 0.001, // spelling: allow (accepted input synonym)
  metres: 0.001, // spelling: allow (accepted input synonym)
  au: AU_IN_KM,
  ua: AU_IN_KM,
  mi: 1.609344,
  mile: 1.609344,
  miles: 1.609344,
  nmi: 1.852,
  ft: 0.0003048,
};

/** Speed units, keyed by lower cased spelling, valued in km/s. */
const SPEED_UNITS: Record<string, number | undefined> = {
  "km/s": 1,
  kms: 1,
  kps: 1,
  "m/s": 0.001,
  ms: 0.001,
  mps: 0.001,
  "km/h": 1 / 3600,
  kmh: 1 / 3600,
  "mi/h": 1.609344 / 3600,
  mph: 1.609344 / 3600,
};

/** Time units, keyed by lower cased spelling, valued in seconds. */
const TIME_UNITS: Record<string, number | undefined> = {
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
  y: 365.25 * 86400,
  yr: 365.25 * 86400,
  year: 365.25 * 86400,
  years: 365.25 * 86400,
};

const VALUE_UNIT_RE = /^([-+]?[\d.]+(?:[eE][-+]?\d+)?)\s*(.*)$/;

function splitValueUnit(raw: string, field: string): { value: number; unit: string } {
  const m = VALUE_UNIT_RE.exec(raw.trim());
  if (!m || !Number.isFinite(Number(m[1]))) {
    throw new ToolError(
      "bad-number",
      `Could not read "${raw}" as the value for ${field}.`,
      "Write the number first and the unit after it, like: 400 km",
    );
  }
  return { value: Number(m[1]), unit: m[2].trim() };
}

/** A length in any supported unit, converted to kilometers. */
export function parseLengthKm(raw: string, field: string): number {
  const { value, unit } = splitValueUnit(raw, field);
  const factor = unit === "" ? 1 : LENGTH_UNITS[unit.toLowerCase()];
  if (factor === undefined) {
    throw new ToolError(
      "bad-unit",
      `"${unit}" is not a length unit this calculator knows.`,
      "Use km, m, AU, mi, nmi or ft. A bare number is read as kilometers.",
    );
  }
  return value * factor;
}

/** A speed in any supported unit, converted to km/s. */
export function parseSpeedKmS(raw: string, field: string): number {
  const { value, unit } = splitValueUnit(raw, field);
  const factor = unit === "" ? 1 : SPEED_UNITS[unit.toLowerCase()];
  if (factor === undefined) {
    throw new ToolError(
      "bad-unit",
      `"${unit}" is not a speed unit this calculator knows.`,
      "Use km/s, m/s, km/h or mph. A bare number is read as km/s.",
    );
  }
  return value * factor;
}

/** A duration in any supported unit, converted to seconds. */
export function parseTimeSeconds(raw: string, field: string): number {
  const { value, unit } = splitValueUnit(raw, field);
  const factor = unit === "" ? 1 : TIME_UNITS[unit.toLowerCase()];
  if (factor === undefined) {
    throw new ToolError(
      "bad-unit",
      `"${unit}" is not a time unit this calculator knows.`,
      "Use s, min, h, d or y. A bare number is read as seconds.",
    );
  }
  return value * factor;
}

/** An angle in degrees or radians, converted to degrees. */
export function parseAngleDegrees(raw: string, field: string): number {
  const { value, unit } = splitValueUnit(raw, field);
  const key = unit.toLowerCase();
  if (key === "" || key.startsWith("deg") || key === "°") return value;
  if (key.startsWith("rad")) return value / DEG;
  throw new ToolError(
    "bad-unit",
    `"${unit}" is not an angle unit this calculator knows.`,
    "Use deg or rad. A bare number is read as degrees.",
  );
}

/* ------------------------------------------------------------------ */
/* Input parsing                                                        */
/* ------------------------------------------------------------------ */

type FieldName =
  | "body"
  | "mu"
  | "radius"
  | "altitude"
  | "orbitRadius"
  | "axis"
  | "eccentricity"
  | "period"
  | "targetAltitude"
  | "targetRadius"
  | "planeChange";

const ALIASES: Record<string, FieldName | undefined> = {
  body: "body",
  planet: "body",
  around: "body",
  primary: "body",
  center: "body",
  mu: "mu",
  gm: "mu",
  "gravitational parameter": "mu",
  radius: "radius",
  "body radius": "radius",
  altitude: "altitude",
  alt: "altitude",
  h: "altitude",
  "orbit radius": "orbitRadius",
  r: "orbitRadius",
  "semi major axis": "axis",
  "semi-major axis": "axis",
  sma: "axis",
  a: "axis",
  eccentricity: "eccentricity",
  e: "eccentricity",
  period: "period",
  t: "period",
  to: "targetAltitude",
  "target altitude": "targetAltitude",
  "transfer to": "targetAltitude",
  "target radius": "targetRadius",
  "plane change": "planeChange",
  inclination: "planeChange",
  "inclination change": "planeChange",
  di: "planeChange",
};

const KNOWN_KEYS =
  "body, mu, radius, altitude, orbit radius, semi-major axis, eccentricity, period, to, target radius, plane change";

export interface OrbitInput {
  body: BodyPreset | null;
  mu?: number;
  radius?: number;
  altitude?: number;
  orbitRadius?: number;
  axis?: number;
  eccentricity?: number;
  period?: number;
  targetAltitude?: number;
  targetRadius?: number;
  planeChange?: number;
}

const LINE_RE = /^([A-Za-z][A-Za-z\s-]*?)\s*[:=]\s*(.+)$/;
const LOOSE_RE = /^([A-Za-z][A-Za-z-]*)\s+(.+)$/;

export function parseInput(input: string): OrbitInput {
  const lines = (input ?? "")
    .split(/[\r\n;]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  if (lines.length === 0) {
    throw new ToolError(
      "empty-input",
      "Describe an orbit to work on.",
      "For example:\nbody: Earth\naltitude: 400 km\nto: 35786 km",
    );
  }

  const out: OrbitInput = { body: null };
  for (const line of lines) {
    const m = LINE_RE.exec(line) ?? LOOSE_RE.exec(line);
    if (!m) {
      // A bare body name on its own line is the most natural shorthand.
      const body = lookupBody(line);
      if (body) {
        out.body = body;
        continue;
      }
      throw new ToolError(
        "bad-line",
        `Could not read "${line}" as a field.`,
        `Write one field per line as "name: value". Known names: ${KNOWN_KEYS}.`,
      );
    }
    const rawKey = m[1].trim().toLowerCase().replace(/\s+/g, " ");
    const value = m[2].trim();
    const field = ALIASES[rawKey];
    if (!field) {
      throw new ToolError(
        "unknown-field",
        `"${m[1].trim()}" is not a field this calculator knows.`,
        `Known names: ${KNOWN_KEYS}.`,
      );
    }

    switch (field) {
      case "body": {
        const body = lookupBody(value);
        if (!body) {
          throw new ToolError(
            "unknown-body",
            `"${value}" is not a body this calculator has constants for.`,
            `Pick one of: ${BODY_NAMES}. Or set "mu" and "radius" yourself.`,
          );
        }
        out.body = body;
        break;
      }
      case "mu": {
        const { value: raw, unit } = splitValueUnit(value, "mu");
        if (unit !== "" && !/^km\^?3\/?s\^?2$/i.test(unit.replace(/\s+/g, ""))) {
          throw new ToolError(
            "bad-unit",
            `"${unit}" is not a unit for a gravitational parameter.`,
            "Give GM in km^3/s^2, which is how planetary constants are published. A bare number is read that way.",
          );
        }
        out.mu = raw;
        break;
      }
      case "radius":
        out.radius = parseLengthKm(value, "body radius");
        break;
      case "altitude":
        out.altitude = parseLengthKm(value, "altitude");
        break;
      case "orbitRadius":
        out.orbitRadius = parseLengthKm(value, "orbit radius");
        break;
      case "axis":
        out.axis = parseLengthKm(value, "semi-major axis");
        break;
      case "period":
        out.period = parseTimeSeconds(value, "period");
        break;
      case "targetAltitude":
        out.targetAltitude = parseLengthKm(value, "target altitude");
        break;
      case "targetRadius":
        out.targetRadius = parseLengthKm(value, "target radius");
        break;
      case "planeChange":
        out.planeChange = parseAngleDegrees(value, "plane change");
        break;
      case "eccentricity": {
        const e = Number(value);
        if (!Number.isFinite(e) || e < 0 || e >= 1) {
          throw new ToolError(
            "bad-eccentricity",
            `An eccentricity of ${value} is not a closed orbit.`,
            "Eccentricity runs from 0 for a circle up to but not including 1 for a parabola.",
          );
        }
        out.eccentricity = e;
        break;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                           */
/* ------------------------------------------------------------------ */

function sig(value: number, digits = 6): string {
  if (!Number.isFinite(value)) return "not a number";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1e9 || abs < 1e-4) return value.toExponential(digits - 1);
  return Number(value.toPrecision(digits)).toLocaleString("en-US", {
    maximumFractionDigits: 12,
    useGrouping: false,
  });
}

function km(value: number): string {
  const au = value / AU_IN_KM;
  if (Math.abs(au) >= 0.01) return `${sig(value)} km (${sig(au, 5)} AU)`;
  return `${sig(value)} km`;
}

function speed(kmPerSecond: number, unit: string): string {
  if (unit === "m/s") return `${sig(kmPerSecond * 1000)} m/s`;
  if (unit === "mi/h") return `${sig((kmPerSecond * 3600) / 1.609344)} mi/h`;
  return `${sig(kmPerSecond)} km/s (${sig(kmPerSecond * 1000, 6)} m/s)`;
}

/** Seconds rendered in the largest unit that keeps the number readable. */
export function formatDuration(seconds: number): string {
  const abs = Math.abs(seconds);
  const parts: string[] = [`${sig(seconds)} s`];
  if (abs >= 86400 * 365.25 * 2) parts.push(`${sig(seconds / (86400 * 365.25), 5)} years`);
  else if (abs >= 86400 * 2) parts.push(`${sig(seconds / 86400, 5)} days`);
  else if (abs >= 3600) parts.push(`${sig(seconds / 3600, 5)} hours`);
  else if (abs >= 60) parts.push(`${sig(seconds / 60, 5)} minutes`);
  return parts.length > 1 ? `${parts[1]} (${parts[0]})` : parts[0];
}

/* ------------------------------------------------------------------ */
/* The tool                                                             */
/* ------------------------------------------------------------------ */

export interface OrbitalOpts {
  /** "km/s" (default), "m/s" or "mi/h". */
  speedUnit?: string;
  /** "summary" or "full". */
  detail?: string;
  [key: string]: unknown;
}

export type OrbitalResult = Record<string, string>;

const DEFAULT_BODY = "Earth";

export function run(input: string, opts: OrbitalOpts = {}): OrbitalResult {
  const speedUnit = String(opts.speedUnit ?? "km/s");
  const detail = String(opts.detail ?? "summary").toLowerCase() === "full" ? "full" : "summary";

  const parsed = parseInput(input);
  const body = parsed.body ?? lookupBody(DEFAULT_BODY)!;
  const mu = parsed.mu ?? body.mu;
  const meanRadius = parsed.radius ?? body.meanRadius;
  const equatorialRadius = parsed.radius ?? body.equatorialRadius;

  if (!(mu > 0)) {
    throw new ToolError(
      "bad-mu",
      "A gravitational parameter has to be greater than zero.",
      "GM for Earth is 398600.4418 km^3/s^2. Set the body instead of mu to get the published value.",
    );
  }

  const out: OrbitalResult = {};
  const named = parsed.mu !== undefined ? "custom" : body.name;
  out.Body =
    parsed.mu !== undefined
      ? `Custom, GM ${sig(mu)} km^3/s^2, radius ${sig(meanRadius)} km`
      : `${body.name}, GM ${sig(mu)} km^3/s^2`;
  if (parsed.mu === undefined) {
    out["Body radius"] = `${sig(meanRadius)} km mean, ${sig(equatorialRadius)} km equatorial`;
    out["Sidereal rotation"] =
      `${formatDuration(body.rotationSeconds)}${body.retrograde ? ", retrograde" : ""}`;
  }
  out["Escape velocity from the surface"] = speed(escapeSpeed(mu, meanRadius), speedUnit);
  out["Surface circular velocity"] =
    `${speed(circularSpeed(mu, meanRadius), speedUnit)}, the speed of a grazing orbit if there were no atmosphere`;

  /* The orbit under study. */
  let radius: number | undefined =
    parsed.orbitRadius ??
    (parsed.altitude !== undefined ? meanRadius + parsed.altitude : undefined);
  let axis = parsed.axis;
  if (axis === undefined && parsed.period !== undefined) {
    axis = axisForPeriod(mu, parsed.period);
  }
  if (radius === undefined && axis !== undefined && parsed.eccentricity === undefined) {
    radius = axis;
  }
  if (axis === undefined && radius !== undefined) {
    axis = parsed.eccentricity !== undefined ? radius / (1 - parsed.eccentricity) : radius;
  }

  if (radius !== undefined && radius <= 0) {
    throw new ToolError(
      "bad-radius",
      "An orbit radius has to be greater than zero.",
      "Give an altitude above the surface instead, like: altitude: 400 km",
    );
  }

  if (radius !== undefined && axis !== undefined) {
    const e = parsed.eccentricity ?? 0;
    const periapsis = axis * (1 - e);
    const apoapsis = axis * (1 + e);

    out.Orbit =
      e === 0
        ? `Circular, radius ${km(radius)}, altitude ${km(radius - meanRadius)} above the mean radius`
        : `Elliptical, semi-major axis ${km(axis)}, eccentricity ${e}`;
    if (radius < meanRadius) {
      out["Orbit warning"] =
        `That radius is inside ${named === "custom" ? "the body" : body.name}, which has a mean radius of ${sig(meanRadius)} km. The numbers below are still the mathematics of the orbit.`;
    }

    if (e === 0) {
      out["Circular velocity"] = speed(circularSpeed(mu, radius), speedUnit);
    } else {
      out.Periapsis = `${km(periapsis)}, altitude ${km(periapsis - meanRadius)}, speed ${speed(visViva(mu, periapsis, axis), speedUnit)}`;
      out.Apoapsis = `${km(apoapsis)}, altitude ${km(apoapsis - meanRadius)}, speed ${speed(visViva(mu, apoapsis, axis), speedUnit)}`;
    }

    const period = orbitalPeriod(mu, axis);
    out["Orbital period"] = formatDuration(period);
    out["Escape velocity at this radius"] = speed(escapeSpeed(mu, radius), speedUnit);
    out["Speed to add to escape"] =
      `${speed(escapeSpeed(mu, radius) - circularSpeed(mu, radius), speedUnit)} on top of a circular orbit here`;

    if (parsed.planeChange !== undefined) {
      const v = e === 0 ? circularSpeed(mu, radius) : visViva(mu, radius, axis);
      out["Plane change"] =
        `${speed(planeChangeDeltaV(v, parsed.planeChange), speedUnit)} to turn the orbit by ${sig(parsed.planeChange, 5)} degrees at ${km(radius)}`;
      if (e === 0) {
        const highSpeed = circularSpeed(mu, apoapsis);
        void highSpeed;
      }
      out["Plane change note"] =
        "A plane change costs less the slower you are going, so raising apoapsis first, turning there, then lowering again is often cheaper than turning in place. This row is the cost of turning in place.";
    }

    if (detail === "full") {
      out["Specific orbital energy"] = `${sig(specificEnergy(mu, axis))} km^2/s^2 per unit mass`;
      out["Specific angular momentum"] =
        `${sig(Math.sqrt(mu * axis * (1 - (parsed.eccentricity ?? 0) ** 2)))} km^2/s`;
      out["Mean motion"] = `${sig((360 / period) * 60, 6)} degrees per minute`;
    }
  }

  /* Synchronous orbit: geostationary when the body is Earth. */
  const synchronousRadius = axisForPeriod(mu, body.rotationSeconds);
  if (parsed.mu === undefined) {
    out[body.name === "Earth" ? "Geostationary orbit" : "Synchronous orbit"] =
      `Radius ${km(synchronousRadius)}, altitude ${km(synchronousRadius - equatorialRadius)} above the equator, speed ${speed(circularSpeed(mu, synchronousRadius), speedUnit)}`;
    if (synchronousRadius < equatorialRadius) {
      out["Synchronous orbit warning"] =
        `${body.name} turns so slowly that a synchronous orbit would sit inside the body.`;
    }
  }

  /* Hohmann transfer. */
  const targetRadius =
    parsed.targetRadius ??
    (parsed.targetAltitude !== undefined ? meanRadius + parsed.targetAltitude : undefined);
  if (targetRadius !== undefined) {
    if (radius === undefined) {
      throw new ToolError(
        "no-start-orbit",
        "A transfer needs a starting orbit as well as a destination.",
        "Add a starting orbit, for example:\nbody: Earth\naltitude: 300 km\nto: 35786 km",
      );
    }
    if (targetRadius <= 0) {
      throw new ToolError(
        "bad-radius",
        "A destination orbit radius has to be greater than zero.",
        "Give the destination as an altitude above the surface, like: to: 35786 km",
      );
    }
    const transfer = hohmannTransfer(mu, radius, targetRadius);
    const direction = targetRadius > radius ? "up" : "down";
    out["Transfer from"] = `${km(radius)}, altitude ${km(radius - meanRadius)}`;
    out["Transfer to"] =
      `${km(targetRadius)}, altitude ${km(targetRadius - meanRadius)}, going ${direction}`;
    out["Transfer ellipse"] =
      `Semi-major axis ${km(transfer.transferAxis)}, half an orbit from one to the other`;
    out["Burn 1 (departure)"] =
      `${speed(Math.abs(transfer.firstBurn), speedUnit)} ${transfer.firstBurn >= 0 ? "prograde" : "retrograde"}`;
    out["Burn 2 (arrival)"] =
      `${speed(Math.abs(transfer.secondBurn), speedUnit)} ${transfer.secondBurn >= 0 ? "prograde" : "retrograde"}`;
    out["Total delta-v"] = speed(transfer.totalDeltaV, speedUnit);
    out["Transfer time"] = formatDuration(transfer.transferSeconds);
    out["Departure phase angle"] =
      `${sig(transfer.phaseAngleDegrees, 5)} degrees: where the destination has to be, measured ahead of you, when you light the first burn`;

    if (parsed.planeChange !== undefined) {
      const arrival = circularSpeed(mu, targetRadius);
      out["Plane change at the destination"] =
        `${speed(planeChangeDeltaV(arrival, parsed.planeChange), speedUnit)} if the turn is made after arrival, against ${speed(planeChangeDeltaV(circularSpeed(mu, radius), parsed.planeChange), speedUnit)} before departure`;
    }
  }

  out["What this leaves out"] =
    "Two body point mass mechanics with instant burns. No atmospheric drag, no oblateness, no third body pull, no finite burn or gravity losses, and no launch cost from the ground. A real mission budget runs higher than these numbers.";

  return out;
}

export default { run } satisfies ToolLogic<string, OrbitalResult, OrbitalOpts>;
