import { ToolError, type ToolLogic } from "../types";

/**
 * Pressure altitude, density altitude, altimeter setting and ISA lookups.
 *
 * Everything here comes from the ICAO / US Standard Atmosphere 1976 model of
 * the lower atmosphere: a troposphere (0 to 11 km) where temperature falls
 * linearly with height at 6.5 K/km, and an isothermal layer (11 to 20 km,
 * the tropopause and lower stratosphere) at a constant -56.5 C. Pressure and
 * density both follow from temperature through the hydrostatic equation and
 * the ideal gas law:
 *
 *   T(h) = T0 - L h                                    (troposphere)
 *   P(h) = P0 (T(h) / T0)^(g0 M / R L)                  (troposphere)
 *   P(h) = P11 exp(-g0 M (h - 11000) / (R T11))         (11 to 20 km)
 *   rho(h) = P(h) / (Rspecific T(h))
 *
 * with T0 = 288.15 K, P0 = 101325 Pa, L = 0.0065 K/m, g0 = 9.80665 m/s^2,
 * M = 0.0289644 kg/mol (the molar mass of dry air) and R = 8.31432 J/(mol K).
 * These are the standard constants; they give 1013.25 hPa at 0 m and
 * 226.32 hPa at 11000 m exactly, the two values every ISA table opens with.
 *
 * Pressure altitude is the inverse of P(h): the height in this standard
 * atmosphere at which the standard pressure equals the actual station
 * pressure, regardless of the actual temperature. It is what an altimeter
 * set to 1013.25 hPa (29.92 inHg) reads.
 *
 * Density altitude is the inverse of the density function: the height at
 * which the standard atmosphere's density equals the actual air density,
 * computed from the actual station pressure and actual temperature through
 * the ideal gas law. Because rho(h) = rho0 (T(h)/T0)^(g0 M / R L - 1) is
 * invertible in closed form, this is computed exactly rather than through
 * the common rule of thumb (density altitude is approximately pressure
 * altitude plus 120 feet per degree Celsius above the ISA temperature),
 * which is only an approximation to the same calculation.
 *
 * Altimeter setting reduces the station pressure to the sea level pressure
 * that would produce it at the field elevation under the standard lapse
 * rate. It is the ISA reduction formula, not the more elaborate procedure a
 * weather station applies with a local temperature history; treat it as an
 * estimate of QNH, not an official one.
 *
 * All of this is troposphere and lower stratosphere only (0 to 20 km, about
 * 65,600 ft), which comfortably covers every altitude aviation and everyday
 * weather calculations need.
 */

const G0 = 9.80665; // m/s^2, standard gravity
const MOLAR_MASS = 0.0289644; // kg/mol, dry air
const R_STAR = 8.31432; // J/(mol K)
const R_SPECIFIC = R_STAR / MOLAR_MASS; // J/(kg K), about 287.0528
const LAPSE_RATE = 0.0065; // K/m, troposphere
const T0 = 288.15; // K, sea level standard temperature
const P0 = 101325; // Pa, sea level standard pressure
const RHO0 = P0 / (R_SPECIFIC * T0); // kg/m^3, about 1.225
const EXPONENT = (G0 * MOLAR_MASS) / (R_STAR * LAPSE_RATE); // about 5.255876

const TROPOPAUSE_M = 11000;
const STRATOSPHERE_CEILING_M = 20000;
const T11 = T0 - LAPSE_RATE * TROPOPAUSE_M; // 216.65 K
const P11 = P0 * Math.pow(T11 / T0, EXPONENT);
const RHO11 = P11 / (R_SPECIFIC * T11);

/** ISA temperature at a geopotential height, in kelvin. */
export function isaTemperatureK(heightM: number): number {
  if (heightM <= TROPOPAUSE_M) return T0 - LAPSE_RATE * heightM;
  return T11;
}

/** ISA pressure at a geopotential height, in pascals. */
export function isaPressurePa(heightM: number): number {
  if (heightM <= TROPOPAUSE_M) {
    const t = T0 - LAPSE_RATE * heightM;
    return P0 * Math.pow(t / T0, EXPONENT);
  }
  return P11 * Math.exp((-G0 * MOLAR_MASS * (heightM - TROPOPAUSE_M)) / (R_STAR * T11));
}

/** ISA air density at a geopotential height, in kg/m^3. */
export function isaDensity(heightM: number): number {
  return isaPressurePa(heightM) / (R_SPECIFIC * isaTemperatureK(heightM));
}

/** Pressure altitude: the ISA height at which standard pressure equals `pressurePa`. */
export function pressureAltitudeM(pressurePa: number): number {
  if (pressurePa >= P11) {
    const ratio = pressurePa / P0;
    return (T0 / LAPSE_RATE) * (1 - Math.pow(ratio, 1 / EXPONENT));
  }
  return TROPOPAUSE_M - ((R_STAR * T11) / (G0 * MOLAR_MASS)) * Math.log(pressurePa / P11);
}

/** Density altitude: the ISA height at which standard density equals `densityKgM3`. */
export function densityAltitudeM(densityKgM3: number): number {
  if (densityKgM3 >= RHO11) {
    const ratio = densityKgM3 / RHO0;
    const tRatio = Math.pow(ratio, 1 / (EXPONENT - 1));
    const t = T0 * tRatio;
    return (T0 - t) / LAPSE_RATE;
  }
  return TROPOPAUSE_M - ((R_STAR * T11) / (G0 * MOLAR_MASS)) * Math.log(densityKgM3 / RHO11);
}

/** Actual air density from station pressure and temperature, ideal gas law. */
export function airDensity(pressurePa: number, temperatureK: number): number {
  return pressurePa / (R_SPECIFIC * temperatureK);
}

/** Sea level equivalent pressure (an ISA reduction, an estimate of QNH). */
export function altimeterSettingPa(stationPressurePa: number, elevationM: number): number {
  if (elevationM < 0 || elevationM > TROPOPAUSE_M)
    throw new ToolError(
      "elevation-out-of-range",
      "Altimeter setting is only defined for a field elevation from 0 to 11,000 m (36,089 ft).",
      "Check the elevation value and its unit.",
    );
  return stationPressurePa / Math.pow(1 - (LAPSE_RATE * elevationM) / T0, EXPONENT);
}

/* ------------------------------------------------------------------ */
/* Units                                                                */
/* ------------------------------------------------------------------ */

const HPA_PER_INHG = 33.8638866667;
const HPA_PER_MMHG = 1.33322387415;
const M_PER_FT = 0.3048;

export type PressureUnit = "hPa" | "inHg" | "mmHg";
export type LengthUnit = "m" | "ft";
export type TempUnit = "C" | "F";

function pressureToPa(value: number, unit: PressureUnit): number {
  if (unit === "inHg") return value * HPA_PER_INHG * 100;
  if (unit === "mmHg") return value * HPA_PER_MMHG * 100;
  return value * 100;
}

function paToUnit(pa: number, unit: PressureUnit): number {
  if (unit === "inHg") return pa / 100 / HPA_PER_INHG;
  if (unit === "mmHg") return pa / 100 / HPA_PER_MMHG;
  return pa / 100;
}

function lengthToM(value: number, unit: LengthUnit): number {
  return unit === "ft" ? value * M_PER_FT : value;
}

function mToUnit(value: number, unit: LengthUnit): number {
  return unit === "ft" ? value / M_PER_FT : value;
}

function tempToK(value: number, unit: TempUnit): number {
  const c = unit === "F" ? ((value - 32) * 5) / 9 : value;
  return c + 273.15;
}

function kToC(k: number): number {
  return k - 273.15;
}

function kToF(k: number): number {
  return kToC(k) * 1.8 + 32;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                           */
/* ------------------------------------------------------------------ */

function fmtNum(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "not a number";
  return value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function fmtPressure(pa: number): string {
  return `${fmtNum(paToUnit(pa, "hPa"))} hPa (${fmtNum(paToUnit(pa, "inHg"), 3)} inHg, ${fmtNum(paToUnit(pa, "mmHg"), 1)} mmHg)`;
}

function fmtLength(m: number): string {
  return `${fmtNum(m)} m (${fmtNum(mToUnit(m, "ft"))} ft)`;
}

function fmtTempK(k: number): string {
  return `${fmtNum(kToC(k), 1)} C (${fmtNum(kToF(k), 1)} F)`;
}

function fmtDensity(kgM3: number): string {
  return `${fmtNum(kgM3, 4)} kg/m^3`;
}

/* ------------------------------------------------------------------ */
/* The tool                                                             */
/* ------------------------------------------------------------------ */

export interface PressureAltitudeOpts {
  mode: string; // "forward" | "reverse"
  pressureUnit: string;
  altitudeUnit: string;
  temperatureUnit: string;
  stationPressure: number;
  elevation: number;
  temperature: number;
  altitude: number;
  [key: string]: unknown;
}

export type PressureAltitudeResult = Record<string, string>;

function num(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function run(
  _input: string,
  opts: Partial<PressureAltitudeOpts> = {},
): PressureAltitudeResult {
  const mode = opts.mode === "reverse" ? "reverse" : "forward";
  const pressureUnit: PressureUnit =
    opts.pressureUnit === "inHg" || opts.pressureUnit === "mmHg" ? opts.pressureUnit : "hPa";
  const altitudeUnit: LengthUnit = opts.altitudeUnit === "ft" ? "ft" : "m";
  const temperatureUnit: TempUnit = opts.temperatureUnit === "F" ? "F" : "C";

  if (mode === "reverse") {
    const altitudeRaw = num(opts.altitude, 0);
    const altitudeM = lengthToM(altitudeRaw, altitudeUnit);
    if (altitudeM < 0 || altitudeM > STRATOSPHERE_CEILING_M)
      throw new ToolError(
        "altitude-out-of-range",
        "This calculator covers the ISA model from 0 to 20,000 m (65,617 ft), the troposphere and the lower stratosphere.",
        "Enter an altitude in that range.",
      );

    const pK = isaPressurePa(altitudeM);
    const tK = isaTemperatureK(altitudeM);
    const rho = isaDensity(altitudeM);

    const out: PressureAltitudeResult = {
      Altitude: fmtLength(altitudeM),
      Layer:
        altitudeM <= TROPOPAUSE_M
          ? "Troposphere (temperature falls with height)"
          : "Tropopause / lower stratosphere (isothermal at -56.5 C)",
      "Standard pressure": fmtPressure(pK),
      "Standard temperature": fmtTempK(tK),
      "Standard air density": fmtDensity(rho),
    };
    out["Model"] =
      "ICAO / US Standard Atmosphere 1976: 1013.25 hPa and 15 C at 0 m, falling at 6.5 K/km through the troposphere, isothermal at -56.5 C from 11 to 20 km.";
    return out;
  }

  const stationPressureRaw = num(opts.stationPressure, 1013.25);
  const elevationRaw = num(opts.elevation, 0);
  const temperatureRaw = num(opts.temperature, 15);

  if (stationPressureRaw <= 0)
    throw new ToolError(
      "bad-pressure",
      "Station pressure has to be greater than zero.",
      "Enter the pressure the barometer reads at the field, such as 1013.25 hPa.",
    );

  const stationPressurePa = pressureToPa(stationPressureRaw, pressureUnit);
  const elevationM = lengthToM(elevationRaw, altitudeUnit);
  const temperatureK = tempToK(temperatureRaw, temperatureUnit);

  if (temperatureK <= 0)
    throw new ToolError(
      "below-absolute-zero",
      "Temperature cannot be at or below absolute zero.",
      "Enter a value above -273.15 C (-459.67 F).",
    );

  const pressureAltM = pressureAltitudeM(stationPressurePa);
  const actualDensity = airDensity(stationPressurePa, temperatureK);
  const densityAltM = densityAltitudeM(actualDensity);
  const isaTempAtPA = isaTemperatureK(Math.max(0, Math.min(pressureAltM, STRATOSPHERE_CEILING_M)));
  const isaDeviationC = kToC(temperatureK) - kToC(isaTempAtPA);

  const out: PressureAltitudeResult = {
    "Station pressure": fmtPressure(stationPressurePa),
    "Field elevation": fmtLength(elevationM),
    "Outside air temperature": fmtTempK(temperatureK),
    "Pressure altitude": fmtLength(pressureAltM),
    "ISA standard temperature at this pressure altitude": fmtTempK(isaTempAtPA),
    "ISA temperature deviation": `${isaDeviationC >= 0 ? "+" : ""}${fmtNum(isaDeviationC, 1)} C from standard`,
    "Air density (actual)": fmtDensity(actualDensity),
    "Density altitude": fmtLength(densityAltM),
  };

  try {
    const altimeterPa = altimeterSettingPa(stationPressurePa, elevationM);
    out["Altimeter setting (estimated QNH)"] = fmtPressure(altimeterPa);
  } catch {
    out["Altimeter setting (estimated QNH)"] =
      "Not computed: field elevation is outside the 0 to 11,000 m range this reduction supports.";
  }

  out["What this leaves out"] =
    "The ISA model is a fixed reference atmosphere, not a forecast. Real air deviates from it constantly, altimeter setting here uses the fixed ISA lapse rate rather than a station's actual temperature history, and none of this accounts for local terrain or weather effects on the true pressure field.";

  return out;
}

export default {
  run,
} satisfies ToolLogic<string, PressureAltitudeResult, Partial<PressureAltitudeOpts>>;
