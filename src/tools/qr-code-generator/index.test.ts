import { describe, expect, it } from 'vitest';
import { buildPayload, buildVcardPayload, buildWifiPayload, run } from './index';
import { ToolError } from '../types';

const OPTS = { preset: 'text', ecc: 'M', margin: 4 };

describe('qr-code-generator', () => {
  it('renders SVG markup with path data', async () => {
    const svg = await run('hello world', OPTS);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toMatch(/<path[^>]*\bd="[^"]+"/);
    expect(svg).toContain('</svg>');
  });

  it('honours error correction and margin options', async () => {
    const low = await run('hello world', { ...OPTS, ecc: 'L' });
    const high = await run('hello world', { ...OPTS, ecc: 'H' });
    expect(low).not.toBe(high);

    const tight = await run('hello world', { ...OPTS, margin: 0 });
    expect(tight).toMatch(/viewBox="0 0 21 21"/);
  });

  it('accepts a valid URL under the url preset', async () => {
    const svg = await run('https://example.com/a?b=c', { ...OPTS, preset: 'url' });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(buildPayload('https://example.com/a?b=c', 'url')).toBe('https://example.com/a?b=c');
  });

  it('rejects an invalid URL under the url preset', async () => {
    await expect(run('not a url', { ...OPTS, preset: 'url' })).rejects.toThrowError(ToolError);
    await expect(run('not a url', { ...OPTS, preset: 'url' })).rejects.toThrowError(
      /not a valid URL/,
    );
  });

  it('escapes reserved characters in the wifi payload', () => {
    const payload = buildWifiPayload('my;net:work\np@ss,word\nWPA');
    expect(payload).toBe('WIFI:T:WPA;S:my\\;net\\:work;P:p@ss\\,word;;');
  });

  it('omits the password for open wifi networks', () => {
    expect(buildWifiPayload('Cafe Guest\n\nnopass')).toBe('WIFI:T:nopass;S:Cafe Guest;;');
  });

  it('defaults wifi security to WPA and rejects unknown types', () => {
    expect(buildWifiPayload('home\nhunter2')).toBe('WIFI:T:WPA;S:home;P:hunter2;;');
    expect(() => buildWifiPayload('home\nhunter2\nWPA9')).toThrowError(/Unknown Wi-Fi security/);
  });

  it('requires an SSID for the wifi preset', () => {
    expect(() => buildWifiPayload('\nhunter2\nWPA')).toThrowError(ToolError);
  });

  it('builds a minimal vCard 3.0', async () => {
    const payload = buildVcardPayload('Ada Lovelace\n+1 555 0100\nada@example.com\nAnalytical Co');
    expect(payload.startsWith('BEGIN:VCARD\r\nVERSION:3.0')).toBe(true);
    expect(payload).toContain('N:Lovelace;Ada;;;');
    expect(payload).toContain('FN:Ada Lovelace');
    expect(payload).toContain('TEL;TYPE=CELL:+1 555 0100');
    expect(payload).toContain('EMAIL;TYPE=INTERNET:ada@example.com');
    expect(payload).toContain('ORG:Analytical Co');
    expect(payload.endsWith('END:VCARD')).toBe(true);

    const svg = await run('Ada Lovelace\n+1 555 0100', { ...OPTS, preset: 'vcard' });
    expect(svg.startsWith('<svg')).toBe(true);
  });

  it('escapes commas and semicolons in vCard values', () => {
    const payload = buildVcardPayload('Grace Hopper\n\n\nNavy; Research, Inc');
    expect(payload).toContain('ORG:Navy\\; Research\\, Inc');
  });

  it('requires a name for the vcard preset', () => {
    expect(() => buildVcardPayload('\n+1 555 0100')).toThrowError(ToolError);
  });

  it('rejects empty input', async () => {
    await expect(run('   ', OPTS)).rejects.toThrowError(ToolError);
    expect(() => buildPayload('', 'text')).toThrowError(/Enter the text/);
  });

  it('rejects an unknown preset', () => {
    expect(() => buildPayload('hi', 'barcode')).toThrowError(/Unknown preset/);
  });

  it('rejects a bad error correction level', async () => {
    await expect(run('hi', { ...OPTS, ecc: 'Z' })).rejects.toThrowError(
      /Unknown error correction level/,
    );
  });

  it('rejects an out-of-range margin', async () => {
    await expect(run('hi', { ...OPTS, margin: -1 })).rejects.toThrowError(/Margin must be/);
    await expect(run('hi', { ...OPTS, margin: 99 })).rejects.toThrowError(ToolError);
  });

  it('wraps over-long input in a typed error', async () => {
    await expect(run('x'.repeat(5000), OPTS)).rejects.toThrowError(ToolError);
    await expect(run('x'.repeat(5000), OPTS)).rejects.toThrowError(/Could not encode/);
  });
});
