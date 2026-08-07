import QRCode from 'qrcode';
import { ToolError, type ToolLogic } from '../types';

export interface QrOpts {
  /** Payload shape: 'text' | 'url' | 'wifi' | 'vcard'. */
  preset: string;
  /** Error correction level: 'L' | 'M' | 'Q' | 'H'. */
  ecc: string;
  /** Quiet-zone width in modules. */
  margin: number;
  [key: string]: unknown;
}

const ECC_LEVELS = ['L', 'M', 'Q', 'H'] as const;
type EccLevel = (typeof ECC_LEVELS)[number];

/**
 * Escape a value for the WIFI: payload grammar. Backslash, semicolon, comma,
 * colon and double quote are the reserved characters; a single-pass regex
 * avoids the double-escaping bug you get from chained replaces.
 */
export function escapeWifi(value: string): string {
  return value.replace(/[\\;,:"]/g, (c) => `\\${c}`);
}

/** Escape a vCard 3.0 property value (RFC 2426 §2.4.2). */
export function escapeVcard(value: string): string {
  return value.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');
}

function lines(input: string): string[] {
  return input.split(/\r?\n/).map((l) => l.trim());
}

/**
 * Build a WIFI: payload from three lines — ssid, password, security.
 * Security accepts WPA / WEP / nopass (case-insensitive); the password field
 * is omitted for open networks.
 */
export function buildWifiPayload(input: string): string {
  const [ssid = '', password = '', security = ''] = lines(input);
  if (!ssid)
    throw new ToolError(
      'missing-ssid',
      'The first line must be the network name (SSID).',
      'Enter three lines: SSID, password, then WPA, WEP or nopass.',
    );

  const raw = security || 'WPA';
  const upper = raw.toUpperCase();
  const type =
    upper === 'NOPASS' ? 'nopass' : upper === 'WEP' ? 'WEP' : upper === 'WPA' ? 'WPA' : '';
  if (!type)
    throw new ToolError(
      'bad-security',
      `Unknown Wi-Fi security type "${raw}".`,
      'Use WPA (covers WPA2/WPA3), WEP, or nopass for an open network.',
    );

  const parts = [`T:${type}`, `S:${escapeWifi(ssid)}`];
  if (type !== 'nopass') parts.push(`P:${escapeWifi(password)}`);
  return `WIFI:${parts.join(';')};;`;
}

/**
 * Build a minimal vCard 3.0 from four lines — name, phone, email, org.
 * Only the name is required; blank trailing lines are dropped.
 */
export function buildVcardPayload(input: string): string {
  const [name = '', phone = '', email = '', org = ''] = lines(input);
  if (!name)
    throw new ToolError(
      'missing-name',
      'The first line must be the contact name.',
      'Enter up to four lines: name, phone, email, organisation.',
    );

  const parts = name.split(/\s+/);
  const last = parts.length > 1 ? parts[parts.length - 1]! : '';
  const first = parts.length > 1 ? parts.slice(0, -1).join(' ') : name;

  const out = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${escapeVcard(last)};${escapeVcard(first)};;;`,
    `FN:${escapeVcard(name)}`,
  ];
  if (phone) out.push(`TEL;TYPE=CELL:${escapeVcard(phone)}`);
  if (email) out.push(`EMAIL;TYPE=INTERNET:${escapeVcard(email)}`);
  if (org) out.push(`ORG:${escapeVcard(org)}`);
  out.push('END:VCARD');
  return out.join('\r\n');
}

/** Turn the raw input into the string that actually gets encoded. */
export function buildPayload(input: string, preset: string): string {
  const raw = (input ?? '').trim();
  if (!raw)
    throw new ToolError(
      'empty-input',
      'Enter the text you want encoded in the QR code.',
      'Type a URL, a message, or pick a preset and fill in its lines.',
    );

  switch (preset) {
    case 'url': {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new ToolError(
          'invalid-url',
          `"${raw}" is not a valid URL.`,
          'Include the scheme, e.g. https://example.com/page.',
        );
      }
      return url.toString();
    }
    case 'wifi':
      return buildWifiPayload(raw);
    case 'vcard':
      return buildVcardPayload(raw);
    case 'text':
    case '':
      return raw;
    default:
      throw new ToolError(
        'bad-preset',
        `Unknown preset "${preset}".`,
        'Choose text, url, wifi or vcard.',
      );
  }
}

function normaliseEcc(ecc: string): EccLevel {
  const level = (ecc || 'M').toUpperCase();
  if (!(ECC_LEVELS as readonly string[]).includes(level))
    throw new ToolError(
      'bad-ecc',
      `Unknown error correction level "${ecc}".`,
      'Use L (7%), M (15%), Q (25%) or H (30%).',
    );
  return level as EccLevel;
}

function normaliseMargin(margin: number): number {
  const m = margin ?? 4;
  if (!Number.isFinite(m) || m < 0 || m > 20)
    throw new ToolError(
      'bad-margin',
      'Margin must be between 0 and 20 modules.',
      'The QR spec recommends a quiet zone of at least 4.',
    );
  return Math.floor(m);
}

export const run: ToolLogic<string, string, QrOpts>['run'] = async (input, opts) => {
  const payload = buildPayload(input, opts?.preset ?? 'text');
  const errorCorrectionLevel = normaliseEcc(opts?.ecc ?? 'M');
  const margin = normaliseMargin(opts?.margin ?? 4);

  try {
    return await QRCode.toString(payload, {
      type: 'svg',
      errorCorrectionLevel,
      margin,
    });
  } catch (e) {
    throw new ToolError(
      'encode-failed',
      `Could not encode this input as a QR code: ${(e as Error).message}`,
      'QR codes top out near 3 KB of data — shorten the input or lower the error correction level.',
    );
  }
};

export default { run } satisfies ToolLogic<string, string, QrOpts>;
