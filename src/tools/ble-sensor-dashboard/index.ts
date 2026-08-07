import { ToolError, type ToolLogic } from '../types';

/**
 * The data core of the BLE Sensor Dashboard.
 *
 * The panel owns the radio: only a real browser can hold a Bluetooth GATT
 * connection, so requestDevice, connect, service discovery and the
 * notification subscriptions all live in the Vue island. Everything that
 * turns a characteristic's raw bytes into a labeled reading lives here and
 * stays pure, so the live chart and any saved capture can never disagree
 * about what a byte payload means.
 *
 * The tricky decoders are the two IEEE-11073 medical float formats and the
 * Heart Rate Measurement layout, whose field widths depend on a flags byte.
 * Those are the parts worth reading twice.
 */

/* ------------------------------------------------------------------ *
 * value shapes
 * ------------------------------------------------------------------ */

/** One decoded reading: a name, a value, and the unit it is measured in. */
export interface GattField {
  name: string;
  /** Numeric for anything chartable; a string for text, hex or timestamps. */
  value: number | string;
  /** Unit label, or an empty string when the value carries its own meaning. */
  unit: string;
}

/** The result of decoding one characteristic value. */
export interface ParsedCharacteristic {
  fields: GattField[];
}

/** A characteristic decoder: raw bytes in a DataView, decoded fields out. */
export type GattParser = (view: DataView) => ParsedCharacteristic;

/* ------------------------------------------------------------------ *
 * IEEE-11073 floating point
 * ------------------------------------------------------------------ */

/**
 * Decode an IEEE-11073 16-bit SFLOAT (also called medfloat16), the format
 * used by glucose, CO2 and particulate matter characteristics.
 *
 * The 16 bits split into a signed 4-bit base-10 exponent in the top nibble
 * and a signed 12-bit mantissa in the low three nibbles, so the value is
 * `mantissa * 10^exponent`. Five mantissa codes are reserved for the special
 * values NaN, NRes (not at this resolution), positive and negative infinity,
 * and a reserved slot. Those are checked against the raw 12-bit field before
 * any sign extension, which is the universal implementation of this format.
 */
export function decodeSFloat(raw: number): number {
  const mantissaBits = raw & 0x0fff;
  switch (mantissaBits) {
    case 0x07ff: // NaN
    case 0x0800: // NRes: value is present but not at the stated resolution
    case 0x0801: // reserved for future use
      return NaN;
    case 0x07fe:
      return Infinity;
    case 0x0802:
      return -Infinity;
  }
  let exponent = (raw >> 12) & 0x0f;
  if (exponent >= 0x08) exponent -= 0x10; // 4-bit two's complement
  let mantissa = mantissaBits;
  if (mantissa >= 0x0800) mantissa -= 0x1000; // 12-bit two's complement
  return mantissa * Math.pow(10, exponent);
}

/**
 * Decode an IEEE-11073 32-bit FLOAT (medfloat32), used by the Health
 * Thermometer's Temperature Measurement characteristic.
 *
 * Same idea a size up: a signed 8-bit base-10 exponent in the top byte and a
 * signed 24-bit mantissa below it. The reserved special codes live in the
 * 24-bit mantissa field and are checked before sign extension.
 */
export function decodeFloat(raw: number): number {
  const mantissaBits = raw & 0x00ffffff;
  switch (mantissaBits) {
    case 0x007fffff: // NaN
    case 0x00800000: // NRes
    case 0x00800001: // reserved for future use
      return NaN;
    case 0x007ffffe:
      return Infinity;
    case 0x00800002:
      return -Infinity;
  }
  let exponent = (raw >>> 24) & 0xff;
  if (exponent >= 0x80) exponent -= 0x100; // 8-bit two's complement
  let mantissa = mantissaBits;
  if (mantissa >= 0x00800000) mantissa -= 0x01000000; // 24-bit two's complement
  return mantissa * Math.pow(10, exponent);
}

/* ------------------------------------------------------------------ *
 * small byte helpers
 * ------------------------------------------------------------------ */

/** Read a signed 24-bit little-endian integer. */
function int24LE(view: DataView, offset: number): number {
  const value =
    view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
  return value & 0x800000 ? value - 0x1000000 : value;
}

/** Read an unsigned 24-bit little-endian integer. */
function uint24LE(view: DataView, offset: number): number {
  return (
    view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16)
  );
}

/** Round to at most `places` decimals without trailing float noise. */
function round(value: number, places: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** A missing length is a common cause of a garbled reading, so say so. */
function ensureLength(view: DataView, needed: number, name: string): void {
  if (view.byteLength < needed) {
    throw new ToolError(
      'short-data',
      `${name} needs at least ${needed} byte${needed === 1 ? '' : 's'} but only ${view.byteLength} arrived.`,
      'The sensor sent a shorter payload than the standard defines. The raw bytes are shown as hex instead.',
    );
  }
}

/* ------------------------------------------------------------------ *
 * characteristic parsers
 * ------------------------------------------------------------------ */

function scalar(name: string, value: number, unit: string): ParsedCharacteristic {
  return { fields: [{ name, value, unit }] };
}

function parseBatteryLevel(view: DataView): ParsedCharacteristic {
  ensureLength(view, 1, 'Battery Level');
  return scalar('Battery level', view.getUint8(0), '%');
}

function parseTemperature(view: DataView): ParsedCharacteristic {
  ensureLength(view, 2, 'Temperature');
  return scalar('Temperature', round(view.getInt16(0, true) * 0.01, 2), '°C');
}

function parseHumidity(view: DataView): ParsedCharacteristic {
  ensureLength(view, 2, 'Humidity');
  return scalar('Humidity', round(view.getUint16(0, true) * 0.01, 2), '%');
}

function parsePressure(view: DataView): ParsedCharacteristic {
  ensureLength(view, 4, 'Pressure');
  return scalar('Pressure', round(view.getUint32(0, true) * 0.1, 1), 'Pa');
}

function parseElevation(view: DataView): ParsedCharacteristic {
  ensureLength(view, 3, 'Elevation');
  return scalar('Elevation', round(int24LE(view, 0) * 0.01, 2), 'm');
}

function parseIrradiance(view: DataView): ParsedCharacteristic {
  ensureLength(view, 2, 'Irradiance');
  return scalar('Irradiance', round(view.getUint16(0, true) * 0.1, 1), 'W/m²');
}

function parseUvIndex(view: DataView): ParsedCharacteristic {
  ensureLength(view, 1, 'UV Index');
  return scalar('UV index', view.getUint8(0), '');
}

function parsePollen(view: DataView): ParsedCharacteristic {
  ensureLength(view, 3, 'Pollen Concentration');
  return scalar('Pollen concentration', uint24LE(view, 0), 'grains/m³');
}

function parseCo2(view: DataView): ParsedCharacteristic {
  ensureLength(view, 2, 'CO2 Concentration');
  return scalar('CO2 concentration', round(decodeSFloat(view.getUint16(0, true)), 1), 'ppm');
}

/**
 * PM1, PM2.5 and PM10 all share the SFLOAT layout. The GATT supplement names
 * the unit as kilograms per cubic metre, but every real sensor and the numbers
 * people expect to see are micrograms per cubic metre, so the reading is
 * labeled that way and the SFLOAT decode itself is unit agnostic.
 */
function makePmParser(label: string): GattParser {
  return (view) => {
    ensureLength(view, 2, label);
    return scalar(label, round(decodeSFloat(view.getUint16(0, true)), 1), 'µg/m³');
  };
}

const TEMPERATURE_TYPES: Record<number, string> = {
  1: 'armpit',
  2: 'body (general)',
  3: 'ear (tympanum)',
  4: 'finger',
  5: 'gastrointestinal tract',
  6: 'mouth',
  7: 'rectum',
  8: 'toe',
  9: 'tympanum (ear drum)',
};

/**
 * Health Thermometer Temperature Measurement (0x2A1C).
 *
 * A flags byte decides everything that follows it: bit 0 picks Fahrenheit over
 * Celsius, bit 1 says a seven byte timestamp follows the reading, and bit 2
 * says a one byte body-site type follows that. The reading itself is a 32-bit
 * IEEE-11073 FLOAT.
 */
function parseTemperatureMeasurement(view: DataView): ParsedCharacteristic {
  ensureLength(view, 5, 'Temperature Measurement');
  const flags = view.getUint8(0);
  const fahrenheit = (flags & 0x01) !== 0;
  const temperature = decodeFloat(view.getUint32(1, true));
  const fields: GattField[] = [
    { name: 'Temperature', value: round(temperature, 2), unit: fahrenheit ? '°F' : '°C' },
  ];

  let offset = 5;
  if ((flags & 0x02) !== 0 && offset + 7 <= view.byteLength) {
    const year = view.getUint16(offset, true);
    const month = view.getUint8(offset + 2);
    const day = view.getUint8(offset + 3);
    const hour = view.getUint8(offset + 4);
    const minute = view.getUint8(offset + 5);
    const second = view.getUint8(offset + 6);
    offset += 7;
    fields.push({
      name: 'Measured at',
      value: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)} ${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}`,
      unit: '',
    });
  }
  if ((flags & 0x04) !== 0 && offset < view.byteLength) {
    const type = view.getUint8(offset);
    fields.push({
      name: 'Temperature type',
      value: TEMPERATURE_TYPES[type] ?? `type ${type}`,
      unit: '',
    });
  }
  return { fields };
}

/**
 * Heart Rate Measurement (0x2A37).
 *
 * The first byte is flags. Bit 0 is the width of the heart rate value: clear
 * means a single uint8, set means a uint16, which matters because a value over
 * 255 bpm cannot fit in a byte. Bit 3 adds a uint16 energy expended field, and
 * bit 4 adds a list of RR intervals, each a uint16 in units of 1/1024 second.
 * Bits 1 and 2 report whether the skin contact sensor is supported and, if so,
 * whether contact is currently detected.
 */
function parseHeartRate(view: DataView): ParsedCharacteristic {
  ensureLength(view, 2, 'Heart Rate Measurement');
  const flags = view.getUint8(0);
  const wideValue = (flags & 0x01) !== 0;
  const contactSupported = (flags & 0x04) !== 0;
  const contactDetected = (flags & 0x02) !== 0;
  const energyPresent = (flags & 0x08) !== 0;
  const rrPresent = (flags & 0x10) !== 0;

  let offset = 1;
  let bpm: number;
  if (wideValue) {
    ensureLength(view, 3, 'Heart Rate Measurement');
    bpm = view.getUint16(offset, true);
    offset += 2;
  } else {
    bpm = view.getUint8(offset);
    offset += 1;
  }

  const fields: GattField[] = [{ name: 'Heart rate', value: bpm, unit: 'bpm' }];

  if (contactSupported) {
    fields.push({ name: 'Sensor contact', value: contactDetected ? 'yes' : 'no', unit: '' });
  }

  if (energyPresent && offset + 2 <= view.byteLength) {
    fields.push({ name: 'Energy expended', value: view.getUint16(offset, true), unit: 'kJ' });
    offset += 2;
  }

  if (rrPresent) {
    let index = 1;
    while (offset + 2 <= view.byteLength) {
      const rr = view.getUint16(offset, true);
      offset += 2;
      // 1/1024 second resolution, reported in milliseconds.
      fields.push({ name: `RR interval ${index}`, value: round((rr / 1024) * 1000, 2), unit: 'ms' });
      index += 1;
    }
  }

  return { fields };
}

const BODY_SENSOR_LOCATIONS: Record<number, string> = {
  0: 'other',
  1: 'chest',
  2: 'wrist',
  3: 'finger',
  4: 'hand',
  5: 'ear lobe',
  6: 'foot',
};

function parseBodySensorLocation(view: DataView): ParsedCharacteristic {
  ensureLength(view, 1, 'Body Sensor Location');
  const code = view.getUint8(0);
  return { fields: [{ name: 'Body sensor location', value: BODY_SENSOR_LOCATIONS[code] ?? `location ${code}`, unit: '' }] };
}

/**
 * Cycling Speed and Cadence Measurement (0x2A5B).
 *
 * A flags byte says which of two optional blocks follow: bit 0 a wheel block
 * (cumulative revolutions as a uint32 and the time of the last wheel event as a
 * uint16 in 1/1024 second), bit 1 a crank block with the same shape but a
 * uint16 revolution count. Turning revolutions into a speed needs the wheel
 * circumference, which the sensor does not send, so the raw cumulative counts
 * and event times are the honest GATT-level reading.
 */
function parseCscMeasurement(view: DataView): ParsedCharacteristic {
  ensureLength(view, 1, 'CSC Measurement');
  const flags = view.getUint8(0);
  const wheelPresent = (flags & 0x01) !== 0;
  const crankPresent = (flags & 0x02) !== 0;
  const fields: GattField[] = [];
  let offset = 1;

  if (wheelPresent) {
    ensureLength(view, offset + 6, 'CSC Measurement');
    fields.push({ name: 'Wheel revolutions', value: view.getUint32(offset, true), unit: '' });
    const eventTime = view.getUint16(offset + 4, true);
    fields.push({ name: 'Last wheel event', value: round((eventTime / 1024) * 1000, 2), unit: 'ms' });
    offset += 6;
  }
  if (crankPresent) {
    ensureLength(view, offset + 4, 'CSC Measurement');
    fields.push({ name: 'Crank revolutions', value: view.getUint16(offset, true), unit: '' });
    const eventTime = view.getUint16(offset + 2, true);
    fields.push({ name: 'Last crank event', value: round((eventTime / 1024) * 1000, 2), unit: 'ms' });
  }

  return fields.length ? { fields } : hexFallback(view);
}

/** UTF-8 string characteristics such as the Device Information service fields. */
function parseUtf8String(view: DataView): ParsedCharacteristic {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const text = new TextDecoder('utf-8').decode(bytes).replace(/\0+$/, '');
  return { fields: [{ name: 'Text', value: text, unit: '' }] };
}

/**
 * The last resort: render the payload as a hex string. Reached for an unknown
 * characteristic, or when a known parser rejects a payload that is too short.
 * Reads through the DataView's own window so a value that sits partway into a
 * larger backing buffer is never misread.
 */
export function hexFallback(view: DataView): ParsedCharacteristic {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += (bytes[i] as number).toString(16).padStart(2, '0');
    if (i < bytes.length - 1) hex += ' ';
  }
  return { fields: [{ name: 'Raw bytes', value: hex || '(empty)', unit: '' }] };
}

/**
 * The curated parser table, keyed by the short 16-bit UUID in lowercase hex.
 * Every standard GATT characteristic this tool understands has an entry; a
 * lookup miss falls through to the hex view.
 */
export const GATT_PARSERS: Record<string, GattParser> = {
  '2a19': parseBatteryLevel,
  '2a6e': parseTemperature,
  '2a6f': parseHumidity,
  '2a6d': parsePressure,
  '2a6c': parseElevation,
  '2a77': parseIrradiance,
  '2a76': parseUvIndex,
  '2a75': parsePollen,
  '2a37': parseHeartRate,
  '2a38': parseBodySensorLocation,
  '2a5b': parseCscMeasurement,
  '2a1c': parseTemperatureMeasurement,
  '2bd0': parseCo2,
  '2bd5': makePmParser('PM1 concentration'),
  '2bd6': makePmParser('PM2.5 concentration'),
  '2bd7': makePmParser('PM10 concentration'),
  // Device Information service: plain UTF-8 strings.
  '2a00': parseUtf8String,
  '2a29': parseUtf8String,
  '2a24': parseUtf8String,
  '2a25': parseUtf8String,
  '2a26': parseUtf8String,
  '2a27': parseUtf8String,
  '2a28': parseUtf8String,
};

/* ------------------------------------------------------------------ *
 * UUID naming
 * ------------------------------------------------------------------ */

/**
 * Reduce any accepted UUID spelling to its lowercase 16-bit short form when it
 * belongs to the Bluetooth base range, or null when it does not.
 *
 * Accepts a bare short code ("2a19", "0x2A19"), a 32-bit short code, and the
 * full 128-bit string. A 128-bit UUID outside the base range (a vendor's own)
 * has no short form, so it returns null and callers keep the full string.
 */
export function to16Bit(uuid: string): string | null {
  let u = uuid.trim().toLowerCase();
  if (u.startsWith('0x')) u = u.slice(2);
  if (/^[0-9a-f]{1,4}$/.test(u)) return u.padStart(4, '0');
  if (/^[0-9a-f]{8}-0000-1000-8000-00805f9b34fb$/.test(u)) {
    const first32 = u.slice(0, 8);
    return first32.startsWith('0000') ? first32.slice(4) : null;
  }
  return null;
}

/** Lowercase the UUID and strip a `0x` prefix, without shortening it. */
export function normalizeUuid(uuid: string): string {
  const u = uuid.trim().toLowerCase();
  return u.startsWith('0x') ? u.slice(2) : u;
}

const UUID_NAMES: Record<string, string> = {
  // Services
  '1800': 'Generic Access',
  '1801': 'Generic Attribute',
  '180a': 'Device Information',
  '180f': 'Battery Service',
  '180d': 'Heart Rate',
  '1809': 'Health Thermometer',
  '181a': 'Environmental Sensing',
  '1810': 'Blood Pressure',
  '1816': 'Cycling Speed and Cadence',
  '1818': 'Cycling Power',
  '1826': 'Fitness Machine',
  // Characteristics
  '2a19': 'Battery Level',
  '2a6e': 'Temperature',
  '2a6f': 'Humidity',
  '2a6d': 'Pressure',
  '2a6c': 'Elevation',
  '2a77': 'Irradiance',
  '2a76': 'UV Index',
  '2a75': 'Pollen Concentration',
  '2a37': 'Heart Rate Measurement',
  '2a38': 'Body Sensor Location',
  '2a5b': 'CSC Measurement',
  '2a1c': 'Temperature Measurement',
  '2a1d': 'Temperature Type',
  '2bd0': 'CO2 Concentration',
  '2bd5': 'PM1 Concentration',
  '2bd6': 'PM2.5 Concentration',
  '2bd7': 'PM10 Concentration',
  '2a00': 'Device Name',
  '2a29': 'Manufacturer Name',
  '2a24': 'Model Number',
  '2a25': 'Serial Number',
  '2a26': 'Firmware Revision',
  '2a27': 'Hardware Revision',
  '2a28': 'Software Revision',
};

/** Human name for a service or characteristic UUID, or a tidy hex fallback. */
export function uuidName(uuid: string): string {
  const short = to16Bit(uuid);
  if (short && UUID_NAMES[short]) return UUID_NAMES[short];
  const full = normalizeUuid(uuid);
  if (UUID_NAMES[full]) return UUID_NAMES[full];
  return short ? `0x${short.toUpperCase()}` : uuid;
}

/**
 * The GATT service UUIDs this tool can decode, as 16-bit numbers. The panel
 * hands these to requestDevice as `optionalServices`, which is mandatory:
 * without it a connected device exposes none of its services to the page.
 */
export const SUPPORTED_SERVICES: number[] = [
  0x1800, 0x1801, 0x180a, 0x180f, 0x180d, 0x1809, 0x181a, 0x1810, 0x1816, 0x1818, 0x1826,
];

/* ------------------------------------------------------------------ *
 * dispatch
 * ------------------------------------------------------------------ */

/**
 * Decode one characteristic value: find the parser for this UUID and run it,
 * or fall back to a hex view. A parser that throws on a malformed payload also
 * falls back to hex rather than failing the whole reading.
 */
export function parseCharacteristic(uuid: string, view: DataView): ParsedCharacteristic {
  const short = to16Bit(uuid);
  const key = short ?? normalizeUuid(uuid);
  const parser = GATT_PARSERS[key];
  if (!parser) return hexFallback(view);
  try {
    return parser(view);
  } catch {
    return hexFallback(view);
  }
}

/* ------------------------------------------------------------------ *
 * session buffers
 * ------------------------------------------------------------------ */

/**
 * Append `value` to a rolling buffer and drop the oldest entries once it grows
 * past `maxLen`, so a session that runs for hours stays bounded in memory. The
 * array is mutated in place and returned for chaining.
 */
export function ringBufferPush<T>(buffer: T[], value: T, maxLen: number): T[] {
  buffer.push(value);
  if (maxLen >= 0 && buffer.length > maxLen) {
    buffer.splice(0, buffer.length - maxLen);
  }
  return buffer;
}

/**
 * Thin a series to at most `maxPoints` samples for drawing, always keeping the
 * first and last points so the chart still spans the full time range. Sampling
 * is evenly strided, which is plenty for a line chart and far cheaper than a
 * min/max envelope.
 */
export function downsampleForChart<T>(series: T[], maxPoints: number): T[] {
  if (maxPoints <= 0) return [];
  if (maxPoints === 1) return series.length ? [series[series.length - 1] as T] : [];
  if (series.length <= maxPoints) return series.slice();
  const out: T[] = [];
  const step = (series.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    out.push(series[Math.round(i * step)] as T);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * CSV export
 * ------------------------------------------------------------------ */

/** One logged reading: when it arrived, what field it was, and its value. */
export interface CsvRow {
  /** Epoch milliseconds. */
  t: number;
  name: string;
  value: number | string;
}

/** Render a numeric or string value for display and export. */
export function formatValue(value: number | string): string {
  if (typeof value === 'string') return value;
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  return String(value);
}

function csvEscape(text: string): string {
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * A long-format CSV of a whole session: one row per reading, with an ISO 8601
 * UTC timestamp, the field name, and its value. Field names and values are
 * quoted whenever they contain a comma, quote or newline, so a label like
 * "Heart rate, resting" survives a round trip through a spreadsheet.
 */
export function toCsv(series: CsvRow[]): string {
  const header = 'timestamp,field,value';
  const lines = series.map((row) =>
    [
      csvEscape(new Date(row.t).toISOString()),
      csvEscape(row.name),
      csvEscape(formatValue(row.value)),
    ].join(','),
  );
  return [header, ...lines].join('\n');
}

/* ------------------------------------------------------------------ *
 * tolerant hex input (for the pure decode path)
 * ------------------------------------------------------------------ */

const HEX_FIX =
  'Use pairs of hex digits. Spaces, commas and 0x prefixes are fine, so "01 3c", "0x01,0x3C" and "013C" are the same two bytes.';

/** Parse a loose hex string into bytes: separators and 0x prefixes optional. */
export function parseHexBytes(text: string): Uint8Array {
  let cleaned = '';
  for (const token of text.split(/[\s,]+/)) {
    if (!token) continue;
    cleaned += token.replace(/^0x/i, '');
  }
  if (!/^[0-9a-fA-F]*$/.test(cleaned)) {
    throw new ToolError('invalid-hex', 'That is not a hex byte string.', HEX_FIX);
  }
  if (cleaned.length % 2 !== 0) {
    throw new ToolError(
      'odd-nibbles',
      `Hex input has ${cleaned.length} digits, which is an odd number, so the last byte is incomplete.`,
      HEX_FIX,
    );
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

export interface BleDashboardOpts {
  /** The characteristic UUID the bytes came from, for the decode path. */
  uuid?: string;
}

const USAGE_ROWS: Record<string, string> = {
  'How this works':
    'This tool is a live dashboard. Click Connect a sensor, pick your Bluetooth device from the browser chooser, and the panel subscribes to every readable characteristic and charts each numeric field as it updates.',
  Browsers:
    'Talking to a sensor needs the Web Bluetooth API. Chromium browsers such as Chrome, Edge and Opera ship it on desktop and Android. Firefox, Safari and every browser on iOS do not, so the page checks for the API rather than a browser name.',
  'Sensors that work':
    'Standard GATT characteristics decode into named readings: heart rate, battery level, temperature, humidity, pressure, elevation, CO2 and particulate matter among them. A non-standard characteristic is shown as raw hex instead.',
  'Decode a saved capture':
    'Pass a characteristic UUID and its bytes to decode a reading without a device attached, which is handy for a payload you captured elsewhere.',
  Privacy: 'Everything happens in this tab: your files and inputs never leave your device.',
};

/**
 * With no input this tool is panel first, so it returns usage rows: a live
 * Bluetooth connection only exists in a real browser session. Given a UUID and
 * a hex payload it runs the same decode the live panel runs on each
 * notification, which makes the pure surface useful for a saved capture.
 */
export function run(
  input: string | Uint8Array = '',
  opts: BleDashboardOpts = {},
): Record<string, string> {
  const hasInput = input instanceof Uint8Array ? input.length > 0 : String(input).trim().length > 0;
  if (!hasInput) return { ...USAGE_ROWS };

  const bytes = input instanceof Uint8Array ? input : parseHexBytes(String(input));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const uuid = opts.uuid ?? '';
  const parsed = parseCharacteristic(uuid, view);

  const out: Record<string, string> = { Characteristic: uuid ? uuidName(uuid) : 'Unknown (raw hex)' };
  for (const field of parsed.fields) {
    out[field.name] = field.unit
      ? `${formatValue(field.value)} ${field.unit}`
      : formatValue(field.value);
  }
  return out;
}

export default { run } satisfies ToolLogic<string | Uint8Array, Record<string, string>, BleDashboardOpts>;
