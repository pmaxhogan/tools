import { describe, expect, it } from 'vitest';
import { ToolError } from '../types';
import {
  binaryStringToBytes,
  bytesToBinaryString,
  chipKeyFromName,
  defaultOffsetsFor,
  humanFlashError,
  parseFlashLayout,
  run,
  validateFirmware,
  type ChipKey,
} from './index';

describe('chipKeyFromName', () => {
  it('maps esptool descriptions to keys, most specific first', () => {
    expect(chipKeyFromName('ESP32-S3')).toBe('esp32s3');
    expect(chipKeyFromName('ESP32-S2')).toBe('esp32s2');
    expect(chipKeyFromName('ESP32-C3 (QFN32)')).toBe('esp32c3');
    expect(chipKeyFromName('ESP32-D0WD-V3 (revision v3.0)')).toBe('esp32');
    expect(chipKeyFromName('ESP8266EX')).toBe('esp8266');
  });

  it('is tolerant of spacing and case', () => {
    expect(chipKeyFromName('esp32 s3')).toBe('esp32s3');
    expect(chipKeyFromName('esp32_c3')).toBe('esp32c3');
  });

  it('returns null when nothing matches', () => {
    expect(chipKeyFromName('RP2040')).toBeNull();
    expect(chipKeyFromName('')).toBeNull();
  });
});

describe('defaultOffsetsFor', () => {
  it('places the ESP32 bootloader, partitions and app at the conventional offsets', () => {
    const o = defaultOffsetsFor('esp32');
    expect(o.app).toBe(0x10000);
    expect(o.bootloader).toBe(0x1000);
    expect(o.partitionTable).toBe(0x8000);
    expect(o.full.map((r) => r.address)).toEqual([0x1000, 0x8000, 0x10000]);
  });

  it('keeps the ESP32-S2 bootloader at 0x1000 like the ESP32', () => {
    expect(defaultOffsetsFor('esp32s2').bootloader).toBe(0x1000);
  });

  it('moves the RISC-V bootloaders to 0x0 for the C3 and S3', () => {
    expect(defaultOffsetsFor('esp32c3').bootloader).toBe(0x0);
    expect(defaultOffsetsFor('esp32s3').bootloader).toBe(0x0);
    expect(defaultOffsetsFor('esp32c3').full[0]?.address).toBe(0x0);
    expect(defaultOffsetsFor('esp32s3').app).toBe(0x10000);
  });

  it('flashes the ESP8266 as a single image at 0x0', () => {
    const o = defaultOffsetsFor('esp8266');
    expect(o.app).toBe(0x0);
    expect(o.full).toHaveLength(1);
    expect(o.full[0]?.address).toBe(0x0);
  });

  it('returns copies so a caller cannot corrupt the shared table', () => {
    const first = defaultOffsetsFor('esp32');
    (first.full[0] as { address: number }).address = 0xdead;
    expect(defaultOffsetsFor('esp32').full[0]?.address).toBe(0x1000);
  });

  it('has an entry for every chip key', () => {
    const keys: ChipKey[] = ['esp32', 'esp32s2', 'esp32s3', 'esp32c3', 'esp8266'];
    for (const key of keys) {
      expect(defaultOffsetsFor(key).full.length).toBeGreaterThan(0);
    }
  });
});

describe('parseFlashLayout', () => {
  it('parses an offset table with and without 0x prefixes', () => {
    const regions = parseFlashLayout('0x1000 bootloader.bin\n8000 partitions.bin\n0x10000 app.bin');
    expect(regions).toEqual([
      { address: 0x1000, name: 'bootloader.bin' },
      { address: 0x8000, name: 'partitions.bin' },
      { address: 0x10000, name: 'app.bin' },
    ]);
  });

  it('ignores blank lines and hash comments', () => {
    const regions = parseFlashLayout('# full flash\n\n0x0 merged.bin\n');
    expect(regions).toEqual([{ address: 0x0, name: 'merged.bin' }]);
  });

  it('keeps multi-word file names intact', () => {
    const regions = parseFlashLayout('0x10000 my firmware v2.bin');
    expect(regions[0]?.name).toBe('my firmware v2.bin');
  });

  it('throws on a line that is not offset then name', () => {
    expect(() => parseFlashLayout('0x1000')).toThrow(ToolError);
  });

  it('throws on a non-hex offset', () => {
    try {
      parseFlashLayout('0xZZZZ firmware.bin');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe('bad-offset');
    }
  });

  it('throws on an empty table', () => {
    try {
      parseFlashLayout('   \n# only a comment\n');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ToolError).code).toBe('empty-layout');
    }
  });

  it('detects a duplicate address when no sizes are given', () => {
    try {
      parseFlashLayout('0x10000 a.bin\n0x10000 b.bin');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ToolError).code).toBe('overlap');
    }
  });

  it('accepts a layout whose regions do not overlap given their sizes', () => {
    const regions = parseFlashLayout('0x0 boot.bin\n0x8000 part.bin', [0x7000, 0x1000]);
    expect(regions).toHaveLength(2);
  });

  it('detects an overlap when a file runs into the next region', () => {
    try {
      // boot.bin is 0x9000 bytes starting at 0x0, so it reaches 0x9000 and
      // overruns the partition table at 0x8000.
      parseFlashLayout('0x0 boot.bin\n0x8000 part.bin', [0x9000, 0x1000]);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ToolError).code).toBe('overlap');
    }
  });

  it('detects overlap regardless of line order', () => {
    try {
      parseFlashLayout('0x8000 part.bin\n0x0 boot.bin', [0x1000, 0x9000]);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ToolError).code).toBe('overlap');
    }
  });

  it('throws when the size list does not line up with the regions', () => {
    try {
      parseFlashLayout('0x0 boot.bin\n0x8000 part.bin', [0x1000]);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ToolError).code).toBe('size-mismatch');
    }
  });
});

describe('validateFirmware', () => {
  it('accepts an image that starts with the 0xE9 magic', () => {
    const bytes = new Uint8Array([0xe9, 0x02, 0x02, 0x20, 0x00]);
    const check = validateFirmware(bytes, 'esp32');
    expect(check.magic).toBe(true);
    expect(check.size).toBe(5);
    expect(check.warnings).toHaveLength(0);
  });

  it('warns but does not block when the magic is missing', () => {
    const bytes = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const check = validateFirmware(bytes, 'esp32c3');
    expect(check.magic).toBe(false);
    expect(check.warnings.length).toBeGreaterThan(0);
    expect(check.warnings[0]).toContain('0xE9');
  });

  it('throws on an empty file', () => {
    try {
      validateFirmware(new Uint8Array(0), 'esp8266');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe('empty-firmware');
    }
  });

  it('warns when the file is implausibly large', () => {
    const bytes = new Uint8Array(33 * 1024 * 1024);
    bytes[0] = 0xe9;
    const check = validateFirmware(bytes, 'esp32');
    expect(check.magic).toBe(true);
    expect(check.warnings.some((w) => w.includes('MB'))).toBe(true);
  });
});

describe('humanFlashError', () => {
  it('explains a failed connection and includes the manual reset dance', () => {
    const h = humanFlashError(new Error('Failed to connect to Espressif device: No serial data received.'));
    expect(h.title).toMatch(/could not talk/i);
    expect(h.detail).toMatch(/BOOT/);
    expect(h.detail).toMatch(/EN/);
  });

  it('explains a timeout as a cable or baud problem', () => {
    const h = humanFlashError(new Error('Timed out waiting for packet header'));
    expect(h.title).toMatch(/stopped responding/i);
    expect(h.detail).toMatch(/115200/);
  });

  it('explains a garbled reply as the wrong boot mode', () => {
    const h = humanFlashError(new Error('Invalid head of packet (0x00)'));
    expect(h.title).toMatch(/download mode/i);
  });

  it('explains a chip mismatch', () => {
    const h = humanFlashError(new Error('Unexpected chip id, wrong chip?'));
    expect(h.title).toMatch(/not the chip/i);
  });

  it('explains a verification failure', () => {
    const h = humanFlashError(new Error('MD5 of file does not match data in flash!'));
    expect(h.title).toMatch(/did not verify/i);
  });

  it('explains a lost device mid flash', () => {
    const h = humanFlashError(new Error('The device has been lost.'));
    expect(h.title).toMatch(/disconnected/i);
  });

  it('falls back to the raw message for an unknown error', () => {
    const h = humanFlashError(new Error('Some brand new failure'));
    expect(h.detail).toContain('Some brand new failure');
  });

  it('handles a non-Error thrown value', () => {
    const h = humanFlashError('plain string failure');
    expect(h.detail).toContain('plain string failure');
  });
});

describe('bytesToBinaryString', () => {
  it('round trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0x00, 0xe9, 0x7f, 0x80, 0xff, 0x41]);
    const str = bytesToBinaryString(bytes);
    expect(str.length).toBe(bytes.length);
    expect(binaryStringToBytes(str)).toEqual(bytes);
  });

  it('round trips an image larger than one chunk without a stack overflow', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 123);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const str = bytesToBinaryString(bytes);
    expect(str.length).toBe(bytes.length);
    expect(binaryStringToBytes(str)).toEqual(bytes);
  });

  it('produces one character per byte', () => {
    expect(bytesToBinaryString(new Uint8Array([0x48, 0x69]))).toBe('Hi');
  });

  it('handles an empty image', () => {
    expect(bytesToBinaryString(new Uint8Array(0))).toBe('');
    expect(binaryStringToBytes('')).toEqual(new Uint8Array(0));
  });
});

describe('run', () => {
  it('returns the usage rows for the panel first tool', () => {
    const rows = run();
    expect(Object.keys(rows).length).toBeGreaterThan(0);
    expect(rows.Privacy).toContain('never leave your device');
    expect(rows.Chips).toMatch(/Pico/);
  });
});
