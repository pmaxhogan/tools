/**
 * Wind chill, heat index, dew point, wet bulb, humidex and apparent
 * temperature from air temperature, relative humidity and wind speed.
 *
 * Formula sources:
 * - Wind chill: US National Weather Service, 2001 formula
 *   (`WC = 35.74 + 0.6215T - 35.75V^0.16 + 0.4275TV^0.16`, T in Fahrenheit,
 *   V in mph). Officially valid for T <= 50F and V >= 3 mph.
 * - Heat index: Rothfusz regression as published by the NWS, with the NWS
 *   low/high humidity adjustments. Officially valid for T >= 80F.
 * - Dew point: Magnus formula with the Alduchov and Eskridge (1996)
 *   constants the NWS uses (a=17.625, b=243.04, valid -45C to 60C), with an
 *   Arden Buck (1981) constant set offered as an alternative.
 * - Wet bulb temperature: Stull (2011), "Wet-Bulb Temperature from Relative
 *   Humidity and Air Temperature", valid for RH 5-99% and T -20C to 50C.
 * - Humidex: Environment and Climate Change Canada formula.
 * - Apparent temperature: Steadman (1994) as implemented by the Australian
 *   Bureau of Meteorology (uses 10m wind speed in m/s).
 */
import { ToolError, type ToolLogic } from "../types";

export interface WindChillOpts {
  temperature: number;
  temperatureUnit: string; // "F" | "C"
  humidity: number; // relative humidity, percent
  windSpeed: number;
  windUnit: string; // "mph" | "kmh" | "ms" | "kt"
  dewPointMethod: string; // "magnus" | "buck"
  [key: string]: unknown;
}

export type WindChillResult = Record<string, string>;

const cToF = (c: number): number => (c * 9) / 5 + 32;
const fToC = (f: number): number => ((f - 32) * 5) / 9;

function windToMs(speed: number, unit: string): number {
  switch (unit) {
    case "kmh":
      return speed / 3.6;
    case "kt":
      return speed * 0.514444;
    case "ms":
      return speed;
    case "mph":
    default:
      return speed * 0.44704;
  }
}
const msToMph = (ms: number): number => ms / 0.44704;

/** Dew point via the Magnus approximation. `t` in Celsius, `rh` in percent (0, 100]. */
export function dewPointMagnus(t: number, rh: number): number {
  const a = 17.625;
  const b = 243.04;
  const gamma = Math.log(rh / 100) + (a * t) / (b + t);
  return (b * gamma) / (a - gamma);
}

/** Dew point via the Arden Buck (1981) constants, picking the set for above/below freezing. */
export function dewPointBuck(t: number, rh: number): number {
  const a = t >= 0 ? 17.368 : 17.966;
  const b = t >= 0 ? 238.88 : 247.15;
  const gamma = Math.log(rh / 100) + (a * t) / (b + t);
  return (b * gamma) / (a - gamma);
}

/** NWS 2001 wind chill. `tF` Fahrenheit, `vMph` mph. Only meaningful for tF<=50, vMph>=3. */
export function windChillF(tF: number, vMph: number): number {
  const v16 = Math.pow(vMph, 0.16);
  return 35.74 + 0.6215 * tF - 35.75 * v16 + 0.4275 * tF * v16;
}

/** Rothfusz heat index regression with the NWS low/high humidity adjustments. `tF` Fahrenheit. */
export function heatIndexF(tF: number, rh: number): number {
  const simple = 0.5 * (tF + 61 + (tF - 68) * 1.2 + rh * 0.094);
  if ((simple + tF) / 2 < 80) return simple;

  let hi =
    -42.379 +
    2.04901523 * tF +
    10.14333127 * rh -
    0.22475541 * tF * rh -
    0.00683783 * tF * tF -
    0.05481717 * rh * rh +
    0.00122874 * tF * tF * rh +
    0.00085282 * tF * rh * rh -
    0.00000199 * tF * tF * rh * rh;

  if (rh < 13 && tF >= 80 && tF <= 112) {
    hi -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(tF - 95)) / 17);
  } else if (rh > 85 && tF >= 80 && tF <= 87) {
    hi += ((rh - 85) / 10) * ((87 - tF) / 5);
  }
  return hi;
}

/** Stull (2011) wet bulb approximation. `t` Celsius, `rh` percent. */
export function wetBulbC(t: number, rh: number): number {
  return (
    t * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
    Math.atan(t + rh) -
    Math.atan(rh - 1.676331) +
    0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
    4.686035
  );
}

/** Environment Canada humidex. `t` Celsius, `dewC` dew point Celsius. */
export function humidex(t: number, dewC: number): number {
  const e = 6.11 * Math.exp(5417.753 * (1 / 273.16 - 1 / (273.15 + dewC)));
  return t + 0.5555 * (e - 10);
}

/** Steadman apparent temperature (BOM form). `t` Celsius, `rh` percent, `wsMs` wind speed m/s. */
export function apparentTemperatureC(t: number, rh: number, wsMs: number): number {
  const e = (rh / 100) * 6.105 * Math.exp((17.27 * t) / (237.7 + t));
  return t + 0.33 * e - 0.7 * wsMs - 4.0;
}

function heatIndexCategory(f: number): string {
  if (f < 80) return "Below the heat index range";
  if (f < 90) return "Caution: fatigue possible with prolonged exposure or activity";
  if (f < 103) return "Extreme caution: heat cramps and heat exhaustion possible";
  if (f < 125) return "Danger: heat exhaustion likely, heat stroke possible";
  return "Extreme danger: heat stroke highly likely";
}

function windChillCategory(f: number): string {
  if (f > -20) return "Low risk of frostbite";
  if (f > -35) return "Frostbite possible on exposed skin within 30 minutes";
  if (f > -55) return "Frostbite possible on exposed skin within 10 minutes";
  return "Frostbite possible on exposed skin within 5 minutes";
}

function dewPointComfort(f: number): string {
  if (f < 50) return "Dry";
  if (f < 60) return "Comfortable";
  if (f < 65) return "Slightly humid";
  if (f < 70) return "Somewhat uncomfortable";
  if (f < 75) return "Humid, uncomfortable";
  return "Oppressive, very humid";
}

function fmtPair(c: number, f: number, digits = 1): string {
  return `${c.toFixed(digits)} C (${f.toFixed(digits)} F)`;
}

export function run(_input: string, opts: WindChillOpts): WindChillResult {
  const temperature = Number(opts.temperature);
  const humidity = Number(opts.humidity);
  const windSpeed = Number(opts.windSpeed);
  const unit = opts.temperatureUnit === "C" ? "C" : "F";

  if (!Number.isFinite(temperature))
    throw new ToolError(
      "bad-input",
      "Temperature must be a number.",
      "Enter a numeric temperature.",
    );

  const tempC = unit === "C" ? temperature : fToC(temperature);
  if (tempC < -273.15)
    throw new ToolError(
      "below-absolute-zero",
      "Temperature cannot be below absolute zero.",
      "Enter a value at or above -273.15 C (-459.67 F).",
    );

  if (!Number.isFinite(humidity) || humidity <= 0 || humidity > 100)
    throw new ToolError(
      "bad-humidity",
      "Relative humidity must be greater than 0 and at most 100 percent.",
      "Enter a value between 1 and 100.",
    );

  if (!Number.isFinite(windSpeed) || windSpeed < 0)
    throw new ToolError(
      "bad-wind",
      "Wind speed cannot be negative.",
      "Enter zero for calm air or a positive speed.",
    );

  const tempF = cToF(tempC);
  const windMs = windToMs(windSpeed, opts.windUnit || "mph");
  const windMph = msToMph(windMs);

  const out: WindChillResult = {
    Input: `${tempC.toFixed(1)} C (${tempF.toFixed(1)} F), ${humidity}% relative humidity, wind ${windMph.toFixed(1)} mph (${windMs.toFixed(1)} m/s)`,
  };

  // Wind chill: NWS formula only officially applies at or below 50F with wind at or above 3 mph.
  if (tempF <= 50 && windMph >= 3) {
    const wcF = windChillF(tempF, windMph);
    const wcC = fToC(wcF);
    out["Wind chill (NWS)"] = `${fmtPair(wcC, wcF)}. ${windChillCategory(wcF)}.`;
  } else {
    out["Wind chill (NWS)"] =
      "Not applicable (the NWS formula only applies at or below 50 F / 10 C with wind at or above 3 mph).";
  }

  // Heat index: NWS regression is only meant to be read at or above 80F.
  if (tempF >= 80) {
    const hiF = heatIndexF(tempF, humidity);
    const hiC = fToC(hiF);
    out["Heat index (NWS Rothfusz)"] = `${fmtPair(hiC, hiF)}. ${heatIndexCategory(hiF)}.`;
  } else {
    out["Heat index (NWS Rothfusz)"] =
      "Not applicable (the NWS heat index table starts at 80 F / 26.7 C).";
  }

  const dewC =
    opts.dewPointMethod === "buck"
      ? dewPointBuck(tempC, humidity)
      : dewPointMagnus(tempC, humidity);
  const dewF = cToF(dewC);
  out["Dew point"] =
    `${fmtPair(dewC, dewF)}, using ${opts.dewPointMethod === "buck" ? "Arden Buck" : "Magnus"} constants. ${dewPointComfort(dewF)}.`;

  const wbC = wetBulbC(tempC, humidity);
  const wbF = cToF(wbC);
  const wbInRange = tempC >= -20 && tempC <= 50 && humidity >= 5 && humidity <= 99;
  out["Wet bulb temperature (Stull)"] =
    `${fmtPair(wbC, wbF)}${wbInRange ? "" : " (outside Stull's validated range of -20 to 50 C and 5-99% RH, treat as an extrapolation)"}.`;

  const hmx = humidex(tempC, dewC);
  out["Humidex (Environment Canada)"] =
    `${hmx.toFixed(1)} (Celsius-scaled index; most meaningful above about 20 C / 68 F).`;

  const atC = apparentTemperatureC(tempC, humidity, windMs);
  const atF = cToF(atC);
  out["Apparent temperature (Steadman)"] = fmtPair(atC, atF);

  out["Validity notes"] =
    "Wind chill (NWS 2001) applies at or below 50 F with wind at or above 3 mph. Heat index (Rothfusz) applies at or above 80 F. Wet bulb (Stull 2011) is validated for -20 to 50 C and 5-99% relative humidity. Outside those ranges the figures are shown as informational extrapolations, not official readings.";

  return out;
}

export default { run } satisfies ToolLogic<string, WindChillResult, WindChillOpts>;
