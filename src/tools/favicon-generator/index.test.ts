import { describe, expect, it } from 'vitest';
import { ToolError } from '../types';
import { buildIco, buildLinkTags, buildManifest, readPngSize, run } from './index';

/** Real 8x8 RGBA PNG (75 bytes), produced with node zlib and inlined. */
const PNG_8x8 = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 8, 0, 0, 0, 8, 8, 6, 0, 0,
  0, 196, 15, 190, 139, 0, 0, 0, 18, 73, 68, 65, 84, 120, 218, 99, 136, 246, 190, 246, 31, 31, 102,
  24, 25, 10, 0, 145, 231, 158, 193, 181, 154, 64, 144, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96,
  130,
]);

/** Real 16x8 RGBA PNG (78 bytes): a deliberately non-square source. */
const PNG_16x8 = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 16, 0, 0, 0, 8, 8, 6, 0, 0,
  0, 240, 118, 127, 151, 0, 0, 0, 21, 73, 68, 65, 84, 120, 218, 99, 248, 207, 192, 240, 159, 18,
  204, 48, 106, 192, 112, 48, 0, 0, 13, 53, 255, 1, 38, 118, 52, 64, 0, 0, 0, 0, 73, 69, 78, 68,
  174, 66, 96, 130,
]);

/** Real 256x256 RGBA PNG (334 bytes), base64 to keep the fixture readable. */
const PNG_256 = decodeBase64(
  'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAABFUlEQVR42u3BMQEAAADCoPVP7WsIoAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeAMBPAAB2ClDBAAAAABJRU5ErkJggg==',
);

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

const OPTS = { appName: 'My App', themeColor: '#5B4BD6', bgColor: '#ffffff' };

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Read back the ICONDIRENTRY table of an ICO we produced. */
function parseIco(ico: Uint8Array) {
  const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
  const count = view.getUint16(4, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    entries.push({
      widthByte: ico[at]!,
      heightByte: ico[at + 1]!,
      colorCount: ico[at + 2]!,
      reserved: ico[at + 3]!,
      planes: view.getUint16(at + 4, true),
      bitCount: view.getUint16(at + 6, true),
      byteSize: view.getUint32(at + 8, true),
      offset: view.getUint32(at + 12, true),
    });
  }
  return { reserved: view.getUint16(0, true), type: view.getUint16(2, true), count, entries };
}

describe('favicon-generator: readPngSize', () => {
  it('reads dimensions out of the IHDR', () => {
    expect(readPngSize(PNG_8x8)).toEqual({ width: 8, height: 8 });
    expect(readPngSize(PNG_16x8)).toEqual({ width: 16, height: 8 });
    expect(readPngSize(PNG_256)).toEqual({ width: 256, height: 256 });
  });

  it('rejects bytes without the PNG signature', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0]);
    expect(() => readPngSize(jpeg)).toThrowError(ToolError);
    try {
      readPngSize(jpeg);
    } catch (e) {
      expect((e as ToolError).code).toBe('invalid-png');
    }
  });

  it('rejects a truncated PNG', () => {
    expect(() => readPngSize(PNG_8x8.subarray(0, 20))).toThrowError(/truncated/);
  });

  it('rejects a header whose first chunk is not IHDR', () => {
    const broken = PNG_8x8.slice();
    broken[12] = 73;
    broken[13] = 69;
    broken[14] = 78;
    broken[15] = 68; // "IEND"
    expect(() => readPngSize(broken)).toThrowError(/IHDR/);
  });

  it('rejects zero dimensions', () => {
    const zeroed = PNG_8x8.slice();
    zeroed[19] = 0; // width low byte -> width 0
    expect(() => readPngSize(zeroed)).toThrowError(/zero/);
  });
});

describe('favicon-generator: buildIco', () => {
  it('writes an ICONDIR with the reserved/type/count header', () => {
    const ico = buildIco([{ size: 32, png: PNG_8x8 }]);
    expect([...ico.subarray(0, 4)]).toEqual([0x00, 0x00, 0x01, 0x00]);
    const parsed = parseIco(ico);
    expect(parsed.reserved).toBe(0);
    expect(parsed.type).toBe(1);
    expect(parsed.count).toBe(1);
  });

  it('points every entry at exactly its own PNG blob', () => {
    const images = [
      { size: 16, png: PNG_8x8 },
      { size: 32, png: PNG_16x8 },
      { size: 256, png: PNG_256 },
    ];
    const ico = buildIco(images);
    const parsed = parseIco(ico);

    expect(parsed.count).toBe(3);
    expect(ico.length).toBe(6 + 16 * 3 + PNG_8x8.length + PNG_16x8.length + PNG_256.length);

    let expectedOffset = 6 + 16 * 3;
    parsed.entries.forEach((entry, i) => {
      const source = images[i]!.png;
      expect(entry.offset).toBe(expectedOffset);
      expect(entry.byteSize).toBe(source.length);
      expect(entry.planes).toBe(1);
      expect(entry.bitCount).toBe(32);
      expect(entry.colorCount).toBe(0);
      expect(entry.reserved).toBe(0);

      const blob = ico.subarray(entry.offset, entry.offset + entry.byteSize);
      expect([...blob.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
      expect([...blob]).toEqual([...source]);
      expectedOffset += source.length;
    });
    expect(expectedOffset).toBe(ico.length);
  });

  it('encodes 16 and 32 literally but 256 as a zero byte', () => {
    const parsed = parseIco(
      buildIco([
        { size: 16, png: PNG_8x8 },
        { size: 32, png: PNG_8x8 },
        { size: 256, png: PNG_8x8 },
      ]),
    );
    expect(parsed.entries.map((e) => e.widthByte)).toEqual([16, 32, 0]);
    expect(parsed.entries.map((e) => e.heightByte)).toEqual([16, 32, 0]);
  });

  it('rejects sizes above 256', () => {
    expect(() => buildIco([{ size: 512, png: PNG_8x8 }])).toThrowError(ToolError);
    try {
      buildIco([{ size: 512, png: PNG_8x8 }]);
    } catch (e) {
      expect((e as ToolError).code).toBe('too-large-for-ico');
      expect((e as ToolError).fix).toMatch(/standalone PNG/);
    }
  });

  it('rejects nonsense sizes', () => {
    try {
      buildIco([{ size: 0, png: PNG_8x8 }]);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ToolError).code).toBe('invalid-ico-size');
    }
  });

  it('rejects an empty image list', () => {
    try {
      buildIco([]);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ToolError).code).toBe('no-images');
    }
  });
});

describe('favicon-generator: buildManifest and buildLinkTags', () => {
  it('emits parseable manifest JSON with two icon entries', () => {
    const parsed = JSON.parse(
      buildManifest({
        name: 'Acme Dashboard',
        shortName: 'Acme',
        themeColor: '#5b4bd6',
        bgColor: '#ffffff',
      }),
    );
    expect(parsed.name).toBe('Acme Dashboard');
    expect(parsed.short_name).toBe('Acme');
    expect(parsed.display).toBe('standalone');
    expect(parsed.theme_color).toBe('#5b4bd6');
    expect(parsed.background_color).toBe('#ffffff');
    expect(parsed.icons).toHaveLength(2);
    expect(parsed.icons.map((i: { sizes: string }) => i.sizes)).toEqual(['192x192', '512x512']);
    expect(parsed.icons.every((i: { type: string }) => i.type === 'image/png')).toBe(true);
  });

  it('emits the ico, png, apple touch, manifest and theme-color tags', () => {
    const tags = buildLinkTags({ themeColor: '#5b4bd6' });
    expect(tags).toContain('rel="manifest"');
    expect(tags).toContain('href="/favicon.ico"');
    expect(tags).toContain('sizes="180x180"');
    expect(tags).toContain('rel="apple-touch-icon"');
    expect(tags).toContain('sizes="192x192"');
    expect(tags).toContain('sizes="512x512"');
    expect(tags).toContain('<meta name="theme-color" content="#5b4bd6">');
  });
});

describe('favicon-generator: run', () => {
  it('produces every expected row for a good square source', async () => {
    const out = await run(PNG_256, OPTS);
    expect(Object.keys(out)).toEqual([
      'Source',
      'favicon.ico',
      'site.webmanifest',
      'Link tags',
      'Next step',
    ]);
    expect(out.Source).toBe('256 x 256 PNG, 334 bytes');
    expect(out.Warning).toBeUndefined();
    expect(out['Next step']).toMatch(/editor panel/);
  });

  it('returns an ico data URL that decodes back to a real ICO', async () => {
    const out = await run(PNG_256, OPTS);
    const url = out['favicon.ico']!;
    expect(url.startsWith('data:image/x-icon;base64,')).toBe(true);

    const ico = decodeBase64(url.slice('data:image/x-icon;base64,'.length));
    expect([...ico.subarray(0, 4)]).toEqual([0x00, 0x00, 0x01, 0x00]);

    const parsed = parseIco(ico);
    expect(parsed.count).toBe(1);
    // 256 encodes as the zero byte.
    expect(parsed.entries[0]!.widthByte).toBe(0);
    expect(parsed.entries[0]!.byteSize).toBe(PNG_256.length);
    const blob = ico.subarray(parsed.entries[0]!.offset);
    expect([...blob]).toEqual([...PNG_256]);
  });

  it('threads the options through the manifest and link tags', async () => {
    const out = await run(PNG_256, {
      appName: 'Acme',
      themeColor: '5B4BD6',
      bgColor: '#FFF',
    });
    const manifest = JSON.parse(out['site.webmanifest']!);
    expect(manifest.name).toBe('Acme');
    expect(manifest.short_name).toBe('Acme');
    expect(manifest.theme_color).toBe('#5b4bd6');
    expect(manifest.background_color).toBe('#fff');
    expect(out['Link tags']).toContain('content="#5b4bd6"');
  });

  it('warns about a non-square source but still generates files', async () => {
    const out = await run(PNG_16x8, OPTS);
    expect(out.Warning).toMatch(/not square/);
    expect(out.Source).toBe('16 x 8 PNG, 78 bytes');
    expect(out['favicon.ico']).toMatch(/^data:image\/x-icon;base64,/);
  });

  it('warns about a small source', async () => {
    const out = await run(PNG_8x8, OPTS);
    expect(out.Warning).toMatch(/8 pixels on its short side/);
    expect(out.Warning).not.toMatch(/not square/);
  });

  it('rejects non-PNG bytes with png-only', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);
    await expect(run(jpeg, OPTS)).rejects.toThrowError(ToolError);
    await expect(run(jpeg, OPTS)).rejects.toMatchObject({ code: 'png-only' });
  });

  it('rejects text input with not-an-image', async () => {
    await expect(run('hello world', OPTS)).rejects.toMatchObject({ code: 'not-an-image' });
  });

  it('rejects empty input', async () => {
    await expect(run('', OPTS)).rejects.toMatchObject({ code: 'empty-input' });
    await expect(run(new Uint8Array(0), OPTS)).rejects.toMatchObject({ code: 'empty-input' });
  });

  it('rejects nonsense colors', async () => {
    await expect(run(PNG_256, { ...OPTS, themeColor: 'blurple' })).rejects.toMatchObject({
      code: 'bad-color',
    });
    await expect(run(PNG_256, { ...OPTS, bgColor: '#12345' })).rejects.toMatchObject({
      code: 'bad-color',
    });
  });

  it('surfaces a corrupt PNG header as invalid-png', async () => {
    await expect(run(PNG_8x8.subarray(0, 18), OPTS)).rejects.toMatchObject({
      code: 'invalid-png',
    });
  });
});
