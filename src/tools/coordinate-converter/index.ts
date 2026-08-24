import { ToolError, type ToolLogic } from "../types";

/* ------------------------------------------------------------------ *
 * WGS84 ellipsoid, grid alphabets, small helpers
 * ------------------------------------------------------------------ */

const SEMI_MAJOR = 6378137.0;
const FLATTENING = 1 / 298.257223563;
const K0 = 0.9996;
const ECC = Math.sqrt(FLATTENING * (2 - FLATTENING));
const EARTH_RADIUS_KM = 6371.0088;
const KM_PER_MILE = 1.609344;
const METRES_PER_DEGREE = 111320;

/** UTM and MGRS latitude bands: 8 degrees each from 80S, with X stretched to 84N. */
const LAT_BANDS = "CDEFGHJKLMNPQRSTUVWX";
/** 100 km column letters, one set per zone modulo 3. */
const E100K_SETS = ["ABCDEFGH", "JKLMNPQR", "STUVWXYZ"];
/** 100 km row letters (AA scheme): even zones start five letters along. */
const N100K_SETS = ["ABCDEFGHJKLMNPQRSTUV", "FGHJKLMNPQRSTUVABCDE"];

const toRad = (d: number): number => (d * Math.PI) / 180;
const toDeg = (r: number): number => (r * 180) / Math.PI;
const pad = (n: number, len: number): string => String(n).padStart(len, "0");

function wrapLon(lon: number): number {
  return (((lon % 360) + 540) % 360) - 180;
}

/* ------------------------------------------------------------------ *
 * Transverse Mercator, Kruger series to 6th order in the third
 * flattening. Accurate far past the width of a UTM zone.
 * ------------------------------------------------------------------ */

const NN = FLATTENING / (2 - FLATTENING);
const NN2 = NN * NN;
const NN3 = NN2 * NN;
const NN4 = NN3 * NN;
const NN5 = NN4 * NN;
const NN6 = NN5 * NN;

const RECT_RADIUS = (SEMI_MAJOR / (1 + NN)) * (1 + NN2 / 4 + NN4 / 64 + NN6 / 256);

const ALPHA = [
  (1 / 2) * NN -
    (2 / 3) * NN2 +
    (5 / 16) * NN3 +
    (41 / 180) * NN4 -
    (127 / 288) * NN5 +
    (7891 / 37800) * NN6,
  (13 / 48) * NN2 -
    (3 / 5) * NN3 +
    (557 / 1440) * NN4 +
    (281 / 630) * NN5 -
    (1983433 / 1935360) * NN6,
  (61 / 240) * NN3 - (103 / 140) * NN4 + (15061 / 26880) * NN5 + (167603 / 181440) * NN6,
  (49561 / 161280) * NN4 - (179 / 168) * NN5 + (6601661 / 7257600) * NN6,
  (34729 / 80640) * NN5 - (3418889 / 1995840) * NN6,
  (212378941 / 319334400) * NN6,
];

const BETA = [
  (1 / 2) * NN -
    (2 / 3) * NN2 +
    (37 / 96) * NN3 -
    (1 / 360) * NN4 -
    (81 / 512) * NN5 +
    (96199 / 604800) * NN6,
  (1 / 48) * NN2 +
    (1 / 15) * NN3 -
    (437 / 1440) * NN4 +
    (46 / 105) * NN5 -
    (1118711 / 3870720) * NN6,
  (17 / 480) * NN3 - (37 / 840) * NN4 - (209 / 4480) * NN5 + (5569 / 90720) * NN6,
  (4397 / 161280) * NN4 - (11 / 504) * NN5 - (830251 / 7257600) * NN6,
  (4583 / 161280) * NN5 - (108847 / 3991680) * NN6,
  (20648693 / 638668800) * NN6,
];

/** Forward transverse Mercator: degrees to meters relative to the central meridian. */
function tmForward(lat: number, lon: number, lon0: number): { x: number; y: number } {
  const phi = toRad(lat);
  const lam = toRad(wrapLon(lon - lon0));
  const cosLam = Math.cos(lam);
  const sinLam = Math.sin(lam);
  const tau = Math.tan(phi);

  const sigma = Math.sinh(ECC * Math.atanh((ECC * tau) / Math.sqrt(1 + tau * tau)));
  const tauP = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);

  const xiP = Math.atan2(tauP, cosLam);
  const etaP = Math.asinh(sinLam / Math.sqrt(tauP * tauP + cosLam * cosLam));

  let xi = xiP;
  let eta = etaP;
  for (let j = 1; j <= 6; j++) {
    xi += ALPHA[j - 1] * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
    eta += ALPHA[j - 1] * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
  }

  return { x: K0 * RECT_RADIUS * eta, y: K0 * RECT_RADIUS * xi };
}

/** Inverse transverse Mercator: meters relative to the central meridian back to degrees. */
function tmInverse(x: number, y: number, lon0: number): { lat: number; lon: number } {
  const eta = x / (K0 * RECT_RADIUS);
  const xi = y / (K0 * RECT_RADIUS);

  let xiP = xi;
  let etaP = eta;
  for (let j = 1; j <= 6; j++) {
    xiP -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaP -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }

  const sinhEtaP = Math.sinh(etaP);
  const sinXiP = Math.sin(xiP);
  const cosXiP = Math.cos(xiP);
  const tauP = sinXiP / Math.sqrt(sinhEtaP * sinhEtaP + cosXiP * cosXiP);

  const e2 = ECC * ECC;
  let tau = tauP;
  for (let i = 0; i < 50; i++) {
    const sigma = Math.sinh(ECC * Math.atanh((ECC * tau) / Math.sqrt(1 + tau * tau)));
    // Forward map of the current estimate, compared against the target tauP.
    const tau1 = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
    const dTau =
      (((tauP - tau1) / Math.sqrt(1 + tau1 * tau1)) * (1 + (1 - e2) * tau * tau)) /
      ((1 - e2) * Math.sqrt(1 + tau * tau));
    tau += dTau;
    if (Math.abs(dTau) <= 1e-12) break;
  }

  return { lat: toDeg(Math.atan(tau)), lon: lon0 + toDeg(Math.atan2(sinhEtaP, cosXiP)) };
}

/* ------------------------------------------------------------------ *
 * Range guards
 * ------------------------------------------------------------------ */

function assertRange(lat: number, lon: number): void {
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) {
    throw new ToolError(
      "out-of-range",
      `Latitude ${lat} is outside the range -90 to 90.`,
      "Check the order of the values. Latitude comes first unless N, S, E or W says otherwise.",
    );
  }
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) {
    throw new ToolError(
      "out-of-range",
      `Longitude ${lon} is outside the range -180 to 180.`,
      "Longitude runs from -180 to 180. Wrap the value into that range first.",
    );
  }
}

/* ------------------------------------------------------------------ *
 * UTM
 * ------------------------------------------------------------------ */

export interface UtmPoint {
  zone: number;
  band: string;
  hemisphere: "N" | "S";
  easting: number;
  northing: number;
}

/** UTM zone number, including the southwest Norway and Svalbard exceptions. */
export function utmZone(lat: number, lon: number): number {
  const l = wrapLon(lon);
  let zone = Math.floor((l + 180) / 6) + 1;
  if (zone > 60) zone = 60;
  if (zone < 1) zone = 1;
  // Southwest Norway: zone 32 is widened west at the expense of zone 31.
  if (lat >= 56 && lat < 64 && l >= 3 && l < 12) zone = 32;
  // Svalbard: zones 32, 34 and 36 are absorbed by their neighbors.
  if (lat >= 72 && lat < 84) {
    if (l >= 0 && l < 9) zone = 31;
    else if (l >= 9 && l < 21) zone = 33;
    else if (l >= 21 && l < 33) zone = 35;
    else if (l >= 33 && l < 42) zone = 37;
  }
  return zone;
}

/** Latitude band letter, C at 80S through X at 84N, with I and O left out. */
export function latitudeBand(lat: number): string {
  if (!(lat >= -80) || lat >= 84) {
    throw new ToolError(
      "utm-out-of-band",
      `Latitude ${lat} is outside the UTM grid, which covers 80S to 84N.`,
      "Polar positions use the UPS grid instead. Decimal degrees, DMS and Plus Codes still work here.",
    );
  }
  return LAT_BANDS[Math.min(Math.floor((lat + 80) / 8), 19)];
}

/** Convert geographic degrees to a UTM zone, band, easting and northing. */
export function toUtm(lat: number, lon: number): UtmPoint {
  assertRange(lat, lon);
  const band = latitudeBand(lat);
  const zone = utmZone(lat, lon);
  const lon0 = (zone - 1) * 6 - 180 + 3;
  const { x, y } = tmForward(lat, lon, lon0);
  return {
    zone,
    band,
    hemisphere: lat >= 0 ? "N" : "S",
    easting: x + 500000,
    northing: lat >= 0 ? y : y + 10000000,
  };
}

/** Convert a UTM zone, hemisphere, easting and northing back to degrees. */
export function fromUtm(
  zone: number,
  hemisphere: "N" | "S",
  easting: number,
  northing: number,
): { lat: number; lon: number } {
  if (!Number.isInteger(zone) || zone < 1 || zone > 60) {
    throw new ToolError(
      "unparseable",
      `UTM zone "${zone}" is not a whole number from 1 to 60.`,
      "Write the zone first, like 18T 583959 4507523.",
    );
  }
  const lon0 = (zone - 1) * 6 - 180 + 3;
  const y = hemisphere === "S" ? northing - 10000000 : northing;
  const p = tmInverse(easting - 500000, y, lon0);
  return { lat: p.lat, lon: wrapLon(p.lon) };
}

/* ------------------------------------------------------------------ *
 * MGRS
 * ------------------------------------------------------------------ */

const MGRS_DIGITS: Record<number, number> = { 1: 5, 10: 4, 100: 3, 1000: 2, 10000: 1 };

/** Convert degrees to an MGRS reference at the given cell size in meters. */
export function toMgrs(lat: number, lon: number, precision = 1): string {
  const digits = MGRS_DIGITS[precision];
  if (!digits) {
    throw new ToolError(
      "unparseable",
      `MGRS precision ${precision} is not one of 1, 10, 100, 1000 or 10000 meters.`,
      "Pick one of the offered grid sizes.",
    );
  }
  const u = toUtm(lat, lon);
  // MGRS truncates towards the southwest corner of a cell, it never rounds.
  const e = Math.floor(u.easting);
  const n = Math.floor(u.northing);
  const col = Math.floor(e / 100000);
  const row = Math.floor(n / 100000) % 20;
  const colLetter = E100K_SETS[(u.zone - 1) % 3][col - 1];
  const rowLetter = N100K_SETS[(u.zone - 1) % 2][row];
  const eStr = pad(Math.floor((e % 100000) / precision), digits);
  const nStr = pad(Math.floor((n % 100000) / precision), digits);
  return `${u.zone}${u.band}${colLetter}${rowLetter}${eStr}${nStr}`;
}

/** Northing at the bottom of a latitude band, floored to a whole 100 km square. */
function bandBottomNorthing(bandIndex: number): number {
  const lat = bandIndex * 8 - 80;
  // North of the equator a band sits lowest on the central meridian; south of
  // it the band sits lowest at the edge of the zone, so pick a matching lon.
  const u = toUtm(lat, lat >= 0 ? 3 : 0);
  return Math.floor(u.northing / 100000) * 100000;
}

export interface MgrsPoint {
  lat: number;
  lon: number;
  /** Side of the named cell in meters. */
  precisionMeters: number;
}

/** Decode an MGRS reference to the center of the cell it names. */
export function fromMgrs(text: string): MgrsPoint {
  const label = String(text).trim();
  const s = label.replace(/\s+/g, "").toUpperCase();
  const m = /^(\d{1,2})([A-Z])([A-Z])([A-Z])(\d*)$/.exec(s);
  if (!m) {
    throw new ToolError(
      "unparseable",
      `Could not read "${label}" as an MGRS reference.`,
      "MGRS looks like 18TWL8395907523: zone, band letter, two square letters, then an even count of digits.",
    );
  }
  const zone = Number(m[1]);
  const band = m[2];
  const bandIndex = LAT_BANDS.indexOf(band);
  if (zone < 1 || zone > 60 || bandIndex < 0) {
    throw new ToolError(
      "utm-out-of-band",
      `"${zone}${band}" is not a UTM zone and band. Zones run 1 to 60 and bands run C to X.`,
      "Band letters are C to X with I and O left out, for example 18T.",
    );
  }
  const digits = m[5];
  if (digits.length % 2 !== 0 || digits.length > 10) {
    throw new ToolError(
      "unparseable",
      `MGRS reference "${label}" carries ${digits.length} digits, which is not an even count of 10 or fewer.`,
      "Use the same number of digits for easting and northing, for example 18TWL 83959 07523.",
    );
  }
  const half = digits.length / 2;
  const precisionMeters = half === 0 ? 100000 : Math.pow(10, 5 - half);
  const col = E100K_SETS[(zone - 1) % 3].indexOf(m[3]);
  const row = N100K_SETS[(zone - 1) % 2].indexOf(m[4]);
  if (col < 0 || row < 0) {
    throw new ToolError(
      "unparseable",
      `"${m[3]}${m[4]}" is not a 100 km square in zone ${zone}.`,
      "The two square letters depend on the zone, so copy them from the same source as the digits.",
    );
  }

  const easting = (col + 1) * 100000 + (half ? Number(digits.slice(0, half)) * precisionMeters : 0);
  const withinSquare = half ? Number(digits.slice(half)) * precisionMeters : 0;
  const bottom = bandBottomNorthing(bandIndex);
  let northing = row * 100000 + withinSquare;
  // Row letters repeat every 2,000,000 m, so lift the value into the band.
  for (let i = 0; i < 12 && northing < bottom; i++) northing += 2000000;

  const p = fromUtm(
    zone,
    bandIndex >= 10 ? "N" : "S",
    easting + precisionMeters / 2,
    northing + precisionMeters / 2,
  );
  return { lat: p.lat, lon: p.lon, precisionMeters };
}

/* ------------------------------------------------------------------ *
 * Open Location Code (Plus Codes)
 * ------------------------------------------------------------------ */

const OLC_ALPHABET = "23456789CFGHJMPQRVWX";
const OLC_BASE = 20;
const OLC_SEPARATOR_POSITION = 8;
const OLC_MAX_DIGITS = 15;
const OLC_PAIR_LENGTH = 10;
const OLC_PAIR_PRECISION = 8000; // 20^3
const OLC_GRID_LENGTH = 5;
const OLC_GRID_ROWS = 5;
const OLC_GRID_COLUMNS = 4;
const OLC_FINAL_LAT_PRECISION = OLC_PAIR_PRECISION * Math.pow(OLC_GRID_ROWS, OLC_GRID_LENGTH);
const OLC_FINAL_LON_PRECISION = OLC_PAIR_PRECISION * Math.pow(OLC_GRID_COLUMNS, OLC_GRID_LENGTH);

/** Height in degrees of the cell a Plus Code of this digit length names. */
function plusCodeLatHeight(codeLength: number): number {
  if (codeLength <= OLC_PAIR_LENGTH) return Math.pow(OLC_BASE, Math.floor(codeLength / -2 + 2));
  return Math.pow(OLC_BASE, -3) / Math.pow(OLC_GRID_ROWS, codeLength - OLC_PAIR_LENGTH);
}

/** Encode degrees as a full Plus Code of the given digit length (2 to 15). */
export function toPlusCode(lat: number, lon: number, length = 10): string {
  const codeLength = Math.min(Math.round(length), OLC_MAX_DIGITS);
  if (codeLength < 2 || (codeLength < OLC_PAIR_LENGTH && codeLength % 2 === 1)) {
    throw new ToolError(
      "unparseable",
      `A Plus Code cannot be ${length} digits long.`,
      "Lengths below 10 have to be even, and 15 is the maximum.",
    );
  }
  let latitude = Math.max(-90, Math.min(90, lat));
  const longitude = wrapLon(lon);
  // The very top edge would encode a cell outside the world, so step down one.
  if (latitude === 90) latitude -= plusCodeLatHeight(codeLength);

  let latVal = Math.floor(
    Math.round(latitude * OLC_FINAL_LAT_PRECISION * 1e6) / 1e6 + 90 * OLC_FINAL_LAT_PRECISION,
  );
  let lonVal = Math.floor(
    Math.round(longitude * OLC_FINAL_LON_PRECISION * 1e6) / 1e6 + 180 * OLC_FINAL_LON_PRECISION,
  );

  let code = "";
  if (codeLength > OLC_PAIR_LENGTH) {
    for (let i = 0; i < OLC_GRID_LENGTH; i++) {
      const latDigit = latVal % OLC_GRID_ROWS;
      const lonDigit = lonVal % OLC_GRID_COLUMNS;
      code = OLC_ALPHABET.charAt(latDigit * OLC_GRID_COLUMNS + lonDigit) + code;
      latVal = Math.floor(latVal / OLC_GRID_ROWS);
      lonVal = Math.floor(lonVal / OLC_GRID_COLUMNS);
    }
  } else {
    latVal = Math.floor(latVal / Math.pow(OLC_GRID_ROWS, OLC_GRID_LENGTH));
    lonVal = Math.floor(lonVal / Math.pow(OLC_GRID_COLUMNS, OLC_GRID_LENGTH));
  }
  for (let i = 0; i < OLC_PAIR_LENGTH / 2; i++) {
    code = OLC_ALPHABET.charAt(lonVal % OLC_BASE) + code;
    code = OLC_ALPHABET.charAt(latVal % OLC_BASE) + code;
    latVal = Math.floor(latVal / OLC_BASE);
    lonVal = Math.floor(lonVal / OLC_BASE);
  }

  if (codeLength >= OLC_SEPARATOR_POSITION) {
    const full =
      code.substring(0, OLC_SEPARATOR_POSITION) + "+" + code.substring(OLC_SEPARATOR_POSITION);
    return full.substring(0, codeLength + 1);
  }
  return code.substring(0, codeLength) + "0".repeat(OLC_SEPARATOR_POSITION - codeLength) + "+";
}

export interface PlusCodeArea {
  lat: number;
  lon: number;
  latHeight: number;
  lonWidth: number;
  digits: number;
}

/** Decode a full Plus Code to the center of the area it names. */
export function fromPlusCode(code: string): PlusCodeArea {
  const label = String(code).trim();
  const upper = label.toUpperCase();
  if (!upper.includes("+")) {
    throw new ToolError(
      "unparseable",
      `"${label}" has no plus sign, so it is not a Plus Code.`,
      "A full Plus Code carries eight characters before the plus sign, like 87G7PX7V+4J.",
    );
  }
  if (upper.indexOf("+") !== OLC_SEPARATOR_POSITION) {
    throw new ToolError(
      "short-plus-code",
      `"${label}" is a short Plus Code, which only locates something next to a named place.`,
      "Use the full code instead: eight characters before the plus sign, like 87G7PX7V+4J.",
    );
  }
  const clean = upper.replace(/\+/g, "").replace(/0+$/, "");
  if (!clean.length || [...clean].some((c) => OLC_ALPHABET.indexOf(c) < 0)) {
    throw new ToolError(
      "unparseable",
      `"${label}" holds characters that are not in the Plus Code alphabet.`,
      `Plus Codes use only these characters: ${OLC_ALPHABET}.`,
    );
  }

  let normalLat = -90 * OLC_PAIR_PRECISION;
  let normalLon = -180 * OLC_PAIR_PRECISION;
  let gridLat = 0;
  let gridLon = 0;
  // The five pairs are worth 20, 1, 0.05, 0.0025 and 0.000125 degrees, held
  // here as whole multiples of 1/8000 of a degree: 160000, 8000, 400, 20, 1.
  let placeValue = Math.pow(OLC_BASE, 4);
  let lastPlaceValue = placeValue;
  const pairDigits = Math.min(clean.length, OLC_PAIR_LENGTH);
  for (let i = 0; i + 1 < pairDigits; i += 2) {
    normalLat += OLC_ALPHABET.indexOf(clean.charAt(i)) * placeValue;
    normalLon += OLC_ALPHABET.indexOf(clean.charAt(i + 1)) * placeValue;
    lastPlaceValue = placeValue;
    placeValue /= OLC_BASE;
  }
  let latHeight = lastPlaceValue / OLC_PAIR_PRECISION;
  let lonWidth = lastPlaceValue / OLC_PAIR_PRECISION;

  if (clean.length > OLC_PAIR_LENGTH) {
    let rowValue = Math.pow(OLC_GRID_ROWS, OLC_GRID_LENGTH);
    let colValue = Math.pow(OLC_GRID_COLUMNS, OLC_GRID_LENGTH);
    const last = Math.min(clean.length, OLC_MAX_DIGITS);
    for (let i = OLC_PAIR_LENGTH; i < last; i++) {
      rowValue /= OLC_GRID_ROWS;
      colValue /= OLC_GRID_COLUMNS;
      const digit = OLC_ALPHABET.indexOf(clean.charAt(i));
      gridLat += Math.floor(digit / OLC_GRID_COLUMNS) * rowValue;
      gridLon += (digit % OLC_GRID_COLUMNS) * colValue;
    }
    latHeight = rowValue / OLC_FINAL_LAT_PRECISION;
    lonWidth = colValue / OLC_FINAL_LON_PRECISION;
  }

  const lowLat = normalLat / OLC_PAIR_PRECISION + gridLat / OLC_FINAL_LAT_PRECISION;
  const lowLon = normalLon / OLC_PAIR_PRECISION + gridLon / OLC_FINAL_LON_PRECISION;
  return {
    lat: lowLat + latHeight / 2,
    lon: lowLon + lonWidth / 2,
    latHeight,
    lonWidth,
    digits: Math.min(clean.length, OLC_MAX_DIGITS),
  };
}

/* ------------------------------------------------------------------ *
 * Geohash
 * ------------------------------------------------------------------ */

const GEOHASH_ALPHABET = "0123456789bcdefghjkmnpqrstuvwxyz";

/** Encode degrees as a geohash of the given character length. */
export function toGeohash(lat: number, lon: number, precision = 9): string {
  assertRange(lat, lon);
  const len = Math.max(1, Math.min(Math.round(precision), 12));
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let hash = "";
  let bit = 0;
  let index = 0;
  let evenBit = true;
  while (hash.length < len) {
    if (evenBit) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) {
        index = index * 2 + 1;
        lonMin = mid;
      } else {
        index = index * 2;
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        index = index * 2 + 1;
        latMin = mid;
      } else {
        index = index * 2;
        latMax = mid;
      }
    }
    evenBit = !evenBit;
    if (++bit === 5) {
      hash += GEOHASH_ALPHABET.charAt(index);
      bit = 0;
      index = 0;
    }
  }
  return hash;
}

export interface GeohashArea {
  lat: number;
  lon: number;
  latHeight: number;
  lonWidth: number;
}

/** Decode a geohash to the center of the cell it names. */
export function fromGeohash(hash: string): GeohashArea {
  const s = String(hash).trim().toLowerCase();
  if (!s) throw new ToolError("empty-input", "Enter a geohash to decode.");
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let evenBit = true;
  for (const ch of s) {
    const index = GEOHASH_ALPHABET.indexOf(ch);
    if (index < 0) {
      throw new ToolError(
        "unparseable",
        `"${ch}" is not a geohash character.`,
        "Geohashes use 0 to 9 and b to z without a, i, l or o, for example ezs42.",
      );
    }
    for (let n = 4; n >= 0; n--) {
      const bit = (index >> n) & 1;
      if (evenBit) {
        const mid = (lonMin + lonMax) / 2;
        if (bit === 1) lonMin = mid;
        else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bit === 1) latMin = mid;
        else latMax = mid;
      }
      evenBit = !evenBit;
    }
  }
  return {
    lat: (latMin + latMax) / 2,
    lon: (lonMin + lonMax) / 2,
    latHeight: latMax - latMin,
    lonWidth: lonMax - lonMin,
  };
}

/* ------------------------------------------------------------------ *
 * Human readable angle formats
 * ------------------------------------------------------------------ */

function splitSexagesimal(
  value: number,
  decimals: number,
): { deg: number; min: number; sec: number } {
  const abs = Math.abs(value);
  const scale = Math.pow(10, decimals);
  const totalSec = Math.round(abs * 3600 * scale) / scale;
  let deg = Math.floor(totalSec / 3600);
  let min = Math.floor((totalSec - deg * 3600) / 60);
  let sec = totalSec - deg * 3600 - min * 60;
  if (Number(sec.toFixed(decimals)) >= 60) {
    sec = 0;
    min += 1;
  }
  if (min >= 60) {
    min = 0;
    deg += 1;
  }
  return { deg, min, sec };
}

function dmsPart(value: number, degWidth: number, decimals: number, letters: string): string {
  const { deg, min, sec } = splitSexagesimal(value, decimals);
  const hemi = value < 0 ? letters[1] : letters[0];
  const secStr = sec.toFixed(decimals).padStart(decimals > 0 ? decimals + 3 : 2, "0");
  return `${pad(deg, degWidth)}°${pad(min, 2)}'${secStr}"${hemi}`;
}

function ddmPart(value: number, degWidth: number, decimals: number, letters: string): string {
  const abs = Math.abs(value);
  const scale = Math.pow(10, decimals);
  let deg = Math.floor(abs);
  let min = Math.round((abs - deg) * 60 * scale) / scale;
  if (Number(min.toFixed(decimals)) >= 60) {
    min = 0;
    deg += 1;
  }
  const hemi = value < 0 ? letters[1] : letters[0];
  const minStr = min.toFixed(decimals).padStart(decimals + 3, "0");
  return `${pad(deg, degWidth)}°${minStr}'${hemi}`;
}

/** Degrees, minutes and seconds. */
export function toDms(lat: number, lon: number, secondDecimals = 2): string {
  return `${dmsPart(lat, 2, secondDecimals, "NS")}, ${dmsPart(lon, 3, secondDecimals, "EW")}`;
}

/** Degrees and decimal minutes, the form marine and aviation charts use. */
export function toDdm(lat: number, lon: number, minuteDecimals = 4): string {
  return `${ddmPart(lat, 2, minuteDecimals, "NS")}, ${ddmPart(lon, 3, minuteDecimals, "EW")}`;
}

/** RFC 5870 geo URI. */
export function toGeoUri(lat: number, lon: number, decimals = 6): string {
  return `geo:${lat.toFixed(decimals)},${lon.toFixed(decimals)}`;
}

/** Plain map URLs as strings. Nothing here is fetched. */
export function toMapLinks(lat: number, lon: number): Record<string, string> {
  const la = lat.toFixed(6);
  const lo = lon.toFixed(6);
  return {
    OpenStreetMap: `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=15/${la}/${lo}`,
    "Google Maps": `https://www.google.com/maps/search/?api=1&query=${la},${lo}`,
    "Apple Maps": `https://maps.apple.com/?ll=${la},${lo}&q=${la},${lo}`,
  };
}

/* ------------------------------------------------------------------ *
 * Distance and bearing
 * ------------------------------------------------------------------ */

export interface LatLon {
  lat: number;
  lon: number;
}

/** Great circle distance in kilometers (haversine on a spherical earth). */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial great circle bearing in degrees clockwise from north. */
export function initialBearing(a: LatLon, b: LatLon): number {
  const p1 = toRad(a.lat);
  const p2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const COMPASS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];

/** Nearest 16 point compass name for a bearing. */
export function compassPoint(bearing: number): string {
  return COMPASS[Math.round((((bearing % 360) + 360) % 360) / 22.5) % 16];
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

export interface ParsedPoint {
  lat: number;
  lon: number;
  /** Human name of the format the text was recognized as. */
  format: string;
  /** Side of the cell the input names, when the format implies one. */
  precisionMeters?: number;
  /** Anything the reader should know about how the input was read. */
  note?: string;
  /** Digit count of a Plus Code input, so the output can echo the same length. */
  plusCodeDigits?: number;
}

interface AngleGroup {
  nums: number[];
  marks: string[];
  hemi?: string;
}

const ALLOWED_ANGLE_CHARS = /[^0-9+\-.,;/|°'"NSEWnsew\s]/;

function normalizeAngleText(raw: string): string {
  let s = raw
    .replace(/[º˚∘]/g, "°")
    .replace(/[′’ʹ´]/g, "'")
    .replace(/[″”“ʺ]/g, '"')
    .replace(/−/g, "-")
    .replace(/''/g, '"');
  s = s.replace(/\b(?:latitude|longitude|lat|long|lng|lon)\b\s*[:=]?/gi, " ");
  s = s.replace(/\bdegrees?\b/gi, "°").replace(/\bdeg\b/gi, "°");
  s = s.replace(/\bminutes?\b/gi, "'").replace(/\bmin\b/gi, "'");
  s = s.replace(/\bseconds?\b/gi, '"').replace(/\bsec\b/gi, '"');
  // Letter forms: 40d42m46.1s, 40d42m, 40d.
  s = s.replace(
    /(\d+(?:\.\d+)?)\s*[dD]\s*(\d+(?:\.\d+)?)\s*[mM]\s*(\d+(?:\.\d+)?)\s*[sS]/g,
    "$1° $2' $3\"",
  );
  s = s.replace(/(\d+(?:\.\d+)?)\s*[dD]\s*(\d+(?:\.\d+)?)\s*[mM]/g, "$1° $2'");
  s = s.replace(/(\d+(?:\.\d+)?)\s*[dD](?![A-Za-z])/g, "$1°");
  return s;
}

function tokenizeAngles(text: string, original: string): AngleGroup[] {
  const s = normalizeAngleText(text);
  const bad = ALLOWED_ANGLE_CHARS.exec(s);
  if (bad) {
    const token = s.split(/[\s,;]+/).find((t) => ALLOWED_ANGLE_CHARS.test(t)) ?? bad[0];
    throw new ToolError(
      "unparseable",
      `Could not read "${token}" as part of a coordinate in "${original.trim()}".`,
      "Supported inputs: decimal degrees, DMS, DDM, UTM, MGRS, a Plus Code, a geohash, a geo URI or a map link.",
    );
  }

  const re = /([+-]?\d+(?:\.\d+)?)|(°)|(')|(")|([NSEWnsew])|([,;/|])|(\s+)/g;
  const groups: AngleGroup[] = [];
  let cur: AngleGroup | null = null;
  let pendingHemi: string | undefined;

  const open = (): AngleGroup => {
    const g: AngleGroup = { nums: [], marks: [] };
    if (pendingHemi) {
      g.hemi = pendingHemi;
      pendingHemi = undefined;
    }
    groups.push(g);
    return g;
  };

  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[1] !== undefined) {
      if (cur === null || cur.nums.length >= 3 || cur.marks.includes('"')) cur = open();
      cur.nums.push(Number(m[1]));
    } else if (m[2] !== undefined || m[3] !== undefined || m[4] !== undefined) {
      const mark = m[2] !== undefined ? "°" : m[3] !== undefined ? "'" : '"';
      if (cur === null || cur.nums.length === 0) continue;
      if (cur.marks.includes(mark) && cur.nums.length > 1) {
        const moved = cur.nums.pop() as number;
        cur = open();
        cur.nums.push(moved);
      }
      cur.marks.push(mark);
    } else if (m[5] !== undefined) {
      const letter = m[5].toUpperCase();
      if (cur !== null && cur.nums.length > 0 && !cur.hemi) {
        cur.hemi = letter;
        cur = null;
      } else {
        cur = null;
        pendingHemi = letter;
      }
    } else if (m[6] !== undefined) {
      cur = null;
    }
  }
  return groups;
}

interface AngleValue {
  value: number;
  hemi?: string;
  hasMin: boolean;
  hasSec: boolean;
}

function groupValue(g: AngleGroup, original: string): AngleValue {
  const [d, mi, se] = g.nums;
  const hasMin = g.nums.length >= 2;
  const hasSec = g.nums.length >= 3;
  if (hasMin && (mi < 0 || mi >= 60)) {
    throw new ToolError(
      "unparseable",
      `Minutes value ${mi} in "${original.trim()}" is not between 0 and 60.`,
      "Minutes and seconds each run from 0 up to but not including 60.",
    );
  }
  if (hasSec && (se < 0 || se >= 60)) {
    throw new ToolError(
      "unparseable",
      `Seconds value ${se} in "${original.trim()}" is not between 0 and 60.`,
      "Minutes and seconds each run from 0 up to but not including 60.",
    );
  }
  // Negative zero matters: "-0 30 0" is half a minute south of the equator.
  const sign = d < 0 || Object.is(d, -0) ? -1 : 1;
  const value = sign * (Math.abs(d) + (hasMin ? mi / 60 : 0) + (hasSec ? se / 3600 : 0));
  return { value, hemi: g.hemi, hasMin, hasSec };
}

const isLatLetter = (h?: string): boolean => h === "N" || h === "S";
const isLonLetter = (h?: string): boolean => h === "E" || h === "W";

function anglesToPoint(text: string, original: string): ParsedPoint {
  const groups = tokenizeAngles(text, original);
  if (groups.length !== 2) {
    throw new ToolError(
      "unparseable",
      `Could not read "${original.trim()}" as a coordinate: expected a latitude and a longitude, found ${groups.length}.`,
      "Write both values, for example 40.7128, -74.0060 or 40°42'46\"N 74°00'22\"W.",
    );
  }
  const first = groupValue(groups[0], original);
  const second = groupValue(groups[1], original);

  if (isLatLetter(first.hemi) && isLatLetter(second.hemi)) {
    throw new ToolError(
      "unparseable",
      `"${original.trim()}" carries two north or south letters and no east or west letter.`,
      "One value needs N or S and the other needs E or W.",
    );
  }
  if (isLonLetter(first.hemi) && isLonLetter(second.hemi)) {
    throw new ToolError(
      "unparseable",
      `"${original.trim()}" carries two east or west letters and no north or south letter.`,
      "One value needs N or S and the other needs E or W.",
    );
  }

  const flipped = isLonLetter(first.hemi) || isLatLetter(second.hemi);
  const latV = flipped ? second : first;
  const lonV = flipped ? first : second;
  const signed = (v: AngleValue): number =>
    v.hemi === "S" || v.hemi === "W" ? -Math.abs(v.value) : v.hemi ? Math.abs(v.value) : v.value;

  let lat = signed(latV);
  let lon = signed(lonV);
  let note: string | undefined;

  if (!latV.hemi && !lonV.hemi) {
    if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) {
      const swap = lat;
      lat = lon;
      lon = swap;
      note =
        "Order swapped: the first value is outside the latitude range, so it was read as longitude.";
    } else if (Math.abs(lon) <= 90) {
      note =
        "Order assumed: the first value was read as latitude. Add N, S, E or W to remove the doubt.";
    }
  } else if (flipped) {
    note = "Longitude was written first. The hemisphere letters made the order clear.";
  }

  assertRange(lat, lon);
  const format = [first, second].some((v) => v.hasSec)
    ? "DMS (degrees, minutes, seconds)"
    : [first, second].some((v) => v.hasMin)
      ? "DDM (degrees and decimal minutes)"
      : "Decimal degrees";
  return { lat, lon, format, note };
}

function tryGeoUri(raw: string): ParsedPoint | null {
  if (!/^geo:/i.test(raw)) return null;
  const body = raw.slice(4);
  const nums = /^\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)/.exec(body);
  if (!nums) {
    throw new ToolError(
      "unparseable",
      `Could not read the coordinates in the geo URI "${raw}".`,
      "A geo URI looks like geo:40.7128,-74.0060.",
    );
  }
  const lat = Number(nums[1]);
  const lon = Number(nums[2]);
  assertRange(lat, lon);
  const u = /;u=([\d.]+)/i.exec(body);
  return {
    lat,
    lon,
    format: "geo URI",
    precisionMeters: u ? Number(u[1]) : undefined,
  };
}

function tryMapLink(raw: string): ParsedPoint | null {
  const patterns: [RegExp, string][] = [
    [/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)(?:,[\d.]+z)?/, "Google Maps link"],
    [/[?&]mlat=(-?\d+(?:\.\d+)?)&mlon=(-?\d+(?:\.\d+)?)/i, "OpenStreetMap link"],
    [/#map=[\d.]+\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/, "OpenStreetMap link"],
    [/[?&](?:q|ll|query|center|daddr)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i, "Map link"],
  ];
  for (const [re, format] of patterns) {
    const m = re.exec(raw);
    if (m) {
      const lat = Number(m[1]);
      const lon = Number(m[2]);
      assertRange(lat, lon);
      return { lat, lon, format };
    }
  }
  return null;
}

const PLUS_CODE_SHAPE = /^[23456789CFGHJMPQRVWX0]{2,8}\+[23456789CFGHJMPQRVWX]{0,7}$/i;

function tryPlusCode(raw: string): ParsedPoint | null {
  const token = raw.split(/[\s,]+/).find((t) => t.includes("+") && PLUS_CODE_SHAPE.test(t));
  if (!token) return null;
  const area = fromPlusCode(token);
  return {
    lat: area.lat,
    lon: area.lon,
    format: `Plus Code (${area.digits} digits)`,
    precisionMeters:
      Math.max(area.latHeight, area.lonWidth * Math.cos(toRad(area.lat))) * METRES_PER_DEGREE,
    plusCodeDigits: area.digits,
  };
}

function tryMgrs(raw: string): ParsedPoint | null {
  if (!/^\d{1,2}\s*[A-Za-z]\s*[A-Za-z]\s*[A-Za-z][\d\s]*$/.test(raw.trim())) return null;
  const p = fromMgrs(raw);
  return {
    lat: p.lat,
    lon: p.lon,
    format: "MGRS",
    precisionMeters: p.precisionMeters,
  };
}

const UTM_SHAPE =
  /^(\d{1,2})\s*([A-Za-z])?\s+(\d+(?:\.\d+)?)\s*m?\s*[EeWw]?\s+(\d+(?:\.\d+)?)\s*m?\s*[NnSs]?$/;

function tryUtm(raw: string): ParsedPoint | null {
  const s = raw.trim().replace(/,/g, " ").replace(/\s+/g, " ");
  const m = UTM_SHAPE.exec(s);
  if (!m) return null;
  const zone = Number(m[1]);
  const easting = Number(m[3]);
  const northing = Number(m[4]);
  // Only commit to UTM when the numbers sit inside the grid, so that a bare
  // "40 42 46.1" stays a DMS angle rather than becoming a zone 40 easting.
  if (zone < 1 || zone > 60) return null;
  if (easting < 100000 || easting > 900000) return null;
  if (northing < 0 || northing > 10000000) return null;

  const letter = m[2] ? m[2].toUpperCase() : "";
  let hemisphere: "N" | "S";
  let note: string | undefined;
  if (!letter) {
    hemisphere = "N";
    note = "No zone letter was given, so the northern hemisphere was assumed.";
  } else if (letter === "N" || letter === "S") {
    hemisphere = letter;
    note = `The letter ${letter} was read as a hemisphere, not as a latitude band.`;
  } else if (LAT_BANDS.includes(letter)) {
    hemisphere = LAT_BANDS.indexOf(letter) >= 10 ? "N" : "S";
  } else {
    throw new ToolError(
      "utm-out-of-band",
      `"${letter}" is not a UTM latitude band or hemisphere.`,
      "Bands run C to X with I and O left out, for example 18T. N or S also work as a hemisphere.",
    );
  }

  const p = fromUtm(zone, hemisphere, easting, northing);
  assertRange(p.lat, p.lon);
  return { lat: p.lat, lon: p.lon, format: "UTM", precisionMeters: 1, note };
}

function tryGeohash(raw: string): ParsedPoint | null {
  const s = raw.trim();
  if (!/^[0-9bcdefghjkmnpqrstuvwxyz]{3,12}$/.test(s)) return null;
  if (!/[a-z]/.test(s)) return null;
  const area = fromGeohash(s);
  return {
    lat: area.lat,
    lon: area.lon,
    format: `Geohash (${s.length} characters)`,
    precisionMeters:
      Math.max(area.latHeight, area.lonWidth * Math.cos(toRad(area.lat))) * METRES_PER_DEGREE,
  };
}

/**
 * Read one coordinate written in any supported format.
 *
 * Decimal degrees, DMS, DDM, UTM, MGRS, Plus Codes, geohashes, geo URIs and
 * map links are all recognized from the text alone.
 */
export function parseCoordinate(text: string): ParsedPoint {
  const raw = String(text ?? "").trim();
  if (!raw) {
    throw new ToolError(
      "empty-input",
      "Enter a coordinate to convert.",
      "Try 40.7128, -74.0060 or 40°42'46\"N 74°00'22\"W or 18TWL8395907523.",
    );
  }
  return (
    tryGeoUri(raw) ??
    tryMapLink(raw) ??
    tryPlusCode(raw) ??
    tryMgrs(raw) ??
    tryUtm(raw) ??
    tryGeohash(raw) ??
    anglesToPoint(raw, raw)
  );
}

/* ------------------------------------------------------------------ *
 * run()
 * ------------------------------------------------------------------ */

export interface CoordinateOpts {
  /** Decimal places on the decimal degrees output, 2 to 8. */
  decimals?: number;
  /** MGRS cell size in meters, as a string from the select. */
  mgrsPrecision?: string | number;
  /** Include OpenStreetMap, Google Maps and Apple Maps URLs. */
  links?: boolean;
  [key: string]: unknown;
}

export type CoordinateResult = Record<string, string>;

function fmtMetres(m: number): string {
  if (m >= 1000) {
    const km = m / 1000;
    return `${Number.isInteger(km) ? km : km.toFixed(1)} km`;
  }
  if (m >= 10) return `${Math.round(m)} m`;
  return `${Math.round(m * 10) / 10} m`;
}

function splitPoints(raw: string): string[] {
  // A geo URI uses ";" for its own parameters, so never split one on it.
  if (!/^geo:/i.test(raw) && raw.includes(";")) {
    const parts = raw
      .split(";")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 1) return parts;
  }
  const byBlank = raw
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (byBlank.length > 1) return byBlank;
  const byLine = raw
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (byLine.length > 1) return byLine;
  return [raw];
}

function blockFor(
  p: ParsedPoint,
  decimals: number,
  mgrsPrecision: number,
  links: boolean,
  prefix: string,
): CoordinateResult {
  const out: CoordinateResult = {};
  const key = (k: string): string => (prefix ? `${prefix} ${k}` : k);

  out[key("Detected format")] = p.format;
  out[key("Decimal degrees")] = `${p.lat.toFixed(decimals)}, ${p.lon.toFixed(decimals)}`;
  out[key("DMS")] = toDms(p.lat, p.lon);
  out[key("DDM")] = toDdm(p.lat, p.lon);

  try {
    const u = toUtm(p.lat, p.lon);
    out[key("UTM")] =
      `${u.zone}${u.band} ${Math.round(u.easting)} mE ${Math.round(u.northing)} mN ` +
      `(${u.hemisphere === "N" ? "northern" : "southern"} hemisphere)`;
    out[key("MGRS")] = toMgrs(p.lat, p.lon, mgrsPrecision);
  } catch (err) {
    if (!(err instanceof ToolError) || err.code !== "utm-out-of-band") throw err;
    const msg = "Not defined here. The UTM and MGRS grids stop at 84N and 80S.";
    out[key("UTM")] = msg;
    out[key("MGRS")] = msg;
  }

  out[key("Plus Code")] = toPlusCode(p.lat, p.lon, p.plusCodeDigits ?? 10);
  out[key("Geohash")] = toGeohash(p.lat, p.lon, 9);
  out[key("geo URI")] = toGeoUri(p.lat, p.lon, decimals);

  if (links) {
    const map = toMapLinks(p.lat, p.lon);
    for (const [label, url] of Object.entries(map)) out[key(label)] = url;
  }

  if (p.precisionMeters && p.precisionMeters > 0) {
    out[key("Precision")] =
      `About ${fmtMetres(p.precisionMeters)} across. The position shown is the center of that cell.`;
  }
  if (p.note) out[key("Note")] = p.note;
  return out;
}

export function run(input: string, opts: CoordinateOpts = {}): CoordinateResult {
  const raw = String(input ?? "").trim();
  if (!raw) {
    throw new ToolError(
      "empty-input",
      "Enter a coordinate to convert.",
      "Try 40.7128, -74.0060 or 40°42'46\"N 74°00'22\"W or 18TWL8395907523.",
    );
  }

  const o = opts ?? {};
  const rawDecimals = Number(o.decimals);
  const decimals = Number.isFinite(rawDecimals)
    ? Math.max(2, Math.min(8, Math.round(rawDecimals)))
    : 6;
  const rawPrecision = Number(o.mgrsPrecision);
  const mgrsPrecision = MGRS_DIGITS[rawPrecision] ? rawPrecision : 1;
  const links = o.links !== false;

  const parts = splitPoints(raw);
  if (parts.length > 2) {
    throw new ToolError(
      "unparseable",
      `Found ${parts.length} coordinates. This tool converts one, or two to compare them.`,
      "Enter one coordinate, or two separated by a semicolon or a blank line.",
    );
  }

  if (parts.length === 1) {
    return blockFor(parseCoordinate(parts[0]), decimals, mgrsPrecision, links, "");
  }

  const a = parseCoordinate(parts[0]);
  const b = parseCoordinate(parts[1]);
  const km = haversineKm(a, b);
  const bearing = initialBearing(a, b);
  return {
    ...blockFor(a, decimals, mgrsPrecision, links, "Point 1"),
    ...blockFor(b, decimals, mgrsPrecision, links, "Point 2"),
    Distance: `${km.toFixed(km < 10 ? 3 : 2)} km`,
    "Distance (miles)": `${(km / KM_PER_MILE).toFixed(km < 10 ? 3 : 2)} mi`,
    "Initial bearing": `${bearing.toFixed(1)}° (${compassPoint(bearing)})`,
  };
}

export default { run } satisfies ToolLogic<string, CoordinateResult, CoordinateOpts>;
