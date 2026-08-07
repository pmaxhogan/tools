import { describe, expect, it } from 'vitest';
import { gzipSync, deflateSync } from 'node:zlib';
import { run } from './index';
import { ToolError } from '../types';

const b64 = (s: string | Uint8Array) => Buffer.from(s as never).toString('base64');
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (header: unknown, payload: unknown, sig = 'c2lnbmF0dXJl') =>
  `${b64url(header)}.${b64url(payload)}.${sig}`;

describe('decode-anything: JWT', () => {
  it('decodes header and payload and flags an expired token', async () => {
    const token = jwt(
      { alg: 'HS256', typ: 'JWT' },
      { sub: '1234567890', name: 'Ada Lovelace', iat: 1500000000, exp: 1500003600 },
    );
    const out = await run(token, {});
    expect(out).toContain('Chain: JWT');
    expect(out).toContain('alg HS256');
    expect(out).toContain('"name": "Ada Lovelace"');
    expect(out).toMatch(/exp \(expires\).*expired/);
    expect(out).toContain('2017-07-14');
  });

  it('never claims the signature is valid', async () => {
    const out = await run(jwt({ alg: 'HS256' }, { sub: 'x' }), {});
    expect(out).toContain('unverified');
    expect(out).toContain('Not verified.');
    expect(out).not.toMatch(/signature is valid/i);
  });

  it('flags alg none', async () => {
    const out = await run(`${b64url({ alg: 'none' })}.${b64url({ sub: 'admin' })}.`, {});
    expect(out).toContain('alg "none"');
    expect(out).toContain('unsigned');
  });

  it('marks a future exp as still valid and a future nbf as not valid yet', async () => {
    const future = Math.floor(Date.now() / 1000) + 86400;
    const out = await run(jwt({ alg: 'HS256' }, { exp: future, nbf: future }), {});
    expect(out).toContain('still valid');
    expect(out).toContain('not valid yet');
  });
});

describe('decode-anything: nested chains', () => {
  it('unwraps base64 over gzip over JSON in one pass', async () => {
    const json = JSON.stringify({ user: 'max', admin: true });
    const payload = b64(gzipSync(Buffer.from(json)));
    const out = await run(payload, {});
    expect(out).toContain('Chain: base64 -> gzip -> JSON');
    expect(out).toContain('gzip archive');
    expect(out).toContain('"user": "max"');
    expect(out.trim().endsWith('Nothing more to decode.')).toBe(true);
  });

  it('unwraps base64 over zlib', async () => {
    const payload = b64(deflateSync(Buffer.from('the compressed message goes here')));
    const out = await run(payload, {});
    expect(out).toContain('zlib');
    expect(out).toContain('the compressed message goes here');
  });

  it('unwraps double base64', async () => {
    const out = await run(b64(b64('hello world')), {});
    expect(out).toContain('Chain: base64 -> base64');
    expect(out).toContain('hello world');
  });

  it('decodes URL-encoded JSON', async () => {
    const out = await run(encodeURIComponent('{"name":"maxhogan","id":7}'), {});
    expect(out).toContain('Chain: URL-encoded -> JSON');
    expect(out).toContain('"name": "maxhogan"');
  });

  it('recurses into JSON string leaves and marks the path', async () => {
    const out = await run(JSON.stringify({ token: b64('hello world again') }), {});
    expect(out).toContain('$.token decodes further');
    expect(out).toContain('hello world again');
  });

  it('decodes a data URL', async () => {
    const out = await run(`data:text/plain;base64,${b64('hello world')}`, {});
    expect(out).toContain('Chain: data URL');
    expect(out).toContain('hello world');
  });

  it('decodes base64url without padding', async () => {
    const raw = Buffer.from('{"path":"a/b?c=1"}').toString('base64url');
    const out = await run(raw, {});
    expect(out).toContain('"path": "a/b?c=1"');
  });
});

describe('decode-anything: binary identification', () => {
  it('identifies a hex PNG signature instead of mangling it', async () => {
    const out = await run('89504e470d0a1a0a0000000d49484452', {});
    expect(out).toContain('Chain: hex');
    expect(out).toContain('PNG image');
    expect(out).toContain('89 50 4e 47');
    expect(out).not.toContain('base64');
  });

  it('identifies a base64 PDF header', async () => {
    const out = await run(b64(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff])), {});
    expect(out).toContain('PDF document');
  });
});

describe('decode-anything: false-positive discipline', () => {
  it('leaves plain English undecoded', async () => {
    const out = await run('The quick brown fox jumps over the lazy dog.', {});
    expect(out).toContain('Chain: none detected');
    expect(out).toContain('Nothing more to decode.');
    expect(out).not.toContain('base64');
  });

  it('leaves a single ordinary word undecoded', async () => {
    const out = await run('sendmails', {});
    expect(out).toContain('Chain: none detected');
  });

  it('handles deadbeef by declining and offering the hex reading as an aside', async () => {
    const out = await run('deadbeef', {});
    expect(out).toContain('Chain: none detected');
    expect(out).toContain('Also possible');
    expect(out).toContain('de ad be ef');
  });

  it('does not call every digit string inside JSON a timestamp', async () => {
    const out = await run(JSON.stringify({ sub: '1234567890', account: '1500000000' }), {});
    expect(out).not.toContain('Unix timestamp');
    expect(out).not.toContain('IPv4');
    expect(out).not.toContain('decodes further');
  });

  it('still reads digit strings as times when the field name says so', async () => {
    const out = await run(JSON.stringify({ created_at: '1754521200', userId: '175928847299117063' }), {});
    expect(out).toContain('Unix timestamp (seconds)');
    expect(out).toContain('Snowflake ID');
  });

  it('does not mistake a query string for quoted-printable', async () => {
    const out = await run('a=42&b=43', {});
    expect(out).not.toContain('Quoted-printable');
  });

  it('decodes real quoted-printable', async () => {
    const out = await run('Caf=C3=A9 au lait', {});
    expect(out).toContain('Chain: quoted-printable');
    expect(out).toContain('Café au lait');
  });

  it('handles quoted-printable soft line breaks', async () => {
    const out = await run('the long line continues =\r\nhere', {});
    expect(out).toContain('the long line continues here');
  });
});

describe('decode-anything: identifiers and timestamps', () => {
  it('decodes a 13 digit millisecond timestamp', async () => {
    const out = await run('1754521200000', {});
    expect(out).toContain('Chain: unix timestamp');
    expect(out).toContain('milliseconds');
    expect(out).toContain('2025-08-06T23:00:00.000Z');
  });

  it('decodes a 10 digit second timestamp and notes the IPv4 reading', async () => {
    const out = await run('1754521200', {});
    expect(out).toContain('2025-08-06T23:00:00.000Z');
    expect(out).toContain('Also possible: an IPv4 address');
  });

  it('decodes a Discord snowflake and labels the epoch assumption', async () => {
    const out = await run('175928847299117063', {});
    expect(out).toContain('Snowflake ID');
    expect(out).toContain('Assuming the Discord epoch: 2016-04-30');
    expect(out).toContain('Assuming the Twitter/X epoch');
    expect(out).toContain('worker 1, process 0, increment 7');
  });

  it('decodes a UUID v4 without inventing a timestamp', async () => {
    const out = await run('550e8400-e29b-41d4-a716-446655440000', {});
    expect(out).toContain('UUID version 4');
    expect(out).toContain('RFC 4122');
    expect(out).toContain('random');
    expect(out).not.toContain('timestamp:');
  });

  it('decodes a UUID v7 timestamp', async () => {
    const ms = 1754521200000;
    const h = ms.toString(16).padStart(12, '0');
    const out = await run(`${h.slice(0, 8)}-${h.slice(8, 12)}-7abc-8def-0123456789ab`, {});
    expect(out).toContain('UUID version 7');
    expect(out).toContain('Version 7 timestamp: 2025-08-06T23:00:00.000Z');
  });

  it('decodes a UUID v1 timestamp', async () => {
    const out = await run('c232ab00-9414-11ec-b3c8-9f6bdeced846', {});
    expect(out).toContain('UUID version 1');
    expect(out).toContain('Version 1 timestamp: 2022-02-22');
  });

  it('decodes a MAC address', async () => {
    const out = await run('00:1a:2b:3c:4d:5e', {});
    expect(out).toContain('Chain: MAC address');
    expect(out).toContain('OUI (vendor prefix): 00:1a:2b');
    expect(out).toContain('Globally unique');
    expect(out).toContain('Unicast');
  });

  it('decodes an IPv4 address stored as an integer', async () => {
    const out = await run('3232235777', {});
    expect(out).toContain('192.168.1.1');
  });
});

describe('decode-anything: guards and options', () => {
  it('terminates on values that decode to themselves', async () => {
    for (const self of ['[]', '{}']) {
      const out = await run(self, {});
      expect(out).toContain('JSON');
      expect(out.trim().endsWith('Nothing more to decode.')).toBe(true);
    }
  });

  it('respects maxDepth and says so', async () => {
    const nested = b64(b64(b64('hello world from three layers down')));
    const shallow = await run(nested, { maxDepth: 1 });
    expect(shallow).toContain('Depth limit reached (maxDepth is 1).');
    expect(shallow).not.toContain('hello world from three layers down');

    const deep = await run(nested, { maxDepth: 10 });
    expect(deep).not.toContain('Depth limit reached');
    expect(deep).toContain('hello world from three layers down');
  });

  it('clamps out-of-range maxDepth instead of failing', async () => {
    const out = await run(b64('hello world clamped'), { maxDepth: 999 });
    expect(out).toContain('hello world clamped');
  });

  it('defaults options when none are supplied', async () => {
    const out = await run(b64('hello world defaults'));
    expect(out).toContain('hello world defaults');
  });

  it('hides intermediate values when showIntermediates is off', async () => {
    const payload = b64(JSON.stringify({ user: 'max' }));
    const shown = await run(payload, { showIntermediates: true });
    const hidden = await run(payload, { showIntermediates: false });
    expect(shown).toContain(payload);
    expect(hidden).not.toContain(payload);
    expect(hidden).toContain('"user": "max"');
  });

  it('always ends with the closing line', async () => {
    for (const sample of ['hello there friend', 'deadbeef', '1754521200000']) {
      const out = await run(sample, {});
      expect(out.trim().endsWith('Nothing more to decode.')).toBe(true);
    }
  });

  it('throws a ToolError on empty input', async () => {
    await expect(run('', {})).rejects.toThrowError(ToolError);
    await expect(run('   \n  ', {})).rejects.toThrowError(/Enter something to decode/);
    try {
      await run('', {});
    } catch (e) {
      expect((e as ToolError).code).toBe('empty-input');
      expect((e as ToolError).fix).toMatch(/base64/);
    }
  });
});
