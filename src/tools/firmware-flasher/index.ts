import { ToolError, type ToolLogic } from '../types';

/**
 * The pure core of the firmware flasher.
 *
 * The live flash can only happen in a real browser session: it needs the Web
 * Serial API and Espressif's esptool-js to hold the port, run the sync
 * handshake and stream blocks. That half lives in the panel. Everything that
 * can be decided without a device lives here and stays pure and tested: parsing
 * an offset table, the conventional flash layouts per chip, a firmware sanity
 * check, turning a raw esptool error into a plain-English fix, and the byte to
 * binary string conversion esptool's older API expects.
 *
 * Keeping the layout maths and the error humaniser out of the panel means the
 * rules can be tested exhaustively, and the panel can never quietly disagree
 * with them about where a bootloader goes or what a timeout means.
 */

/* ------------------------------------------------------------------ *
 * chips
 * ------------------------------------------------------------------ */

/** The ESP families this tool flashes over serial. */
export type ChipKey = 'esp32' | 'esp32s2' | 'esp32s3' | 'esp32c3' | 'esp8266';

export const CHIP_KEYS: ChipKey[] = ['esp32', 'esp32s2', 'esp32s3', 'esp32c3', 'esp8266'];

/** Human label for a chip key, for panel dropdowns and messages. */
export const CHIP_LABELS: Record<ChipKey, string> = {
  esp32: 'ESP32',
  esp32s2: 'ESP32-S2',
  esp32s3: 'ESP32-S3',
  esp32c3: 'ESP32-C3',
  esp8266: 'ESP8266',
};

/**
 * Map the chip description or CHIP_NAME that esptool reports back to one of our
 * keys. esptool returns strings like "ESP32-S3", "ESP32-C3 (QFN32)" or
 * "ESP8266EX", so the match is order sensitive: the more specific variants must
 * be tested before the bare "ESP32". Returns null when nothing matches, so the
 * panel can fall back to asking the user rather than guessing an offset.
 */
export function chipKeyFromName(name: string): ChipKey | null {
  const n = name.toUpperCase().replace(/[\s_-]+/g, '');
  if (n.includes('ESP8266')) return 'esp8266';
  if (n.includes('ESP32S2')) return 'esp32s2';
  if (n.includes('ESP32S3')) return 'esp32s3';
  if (n.includes('ESP32C3')) return 'esp32c3';
  if (n.includes('ESP32')) return 'esp32';
  return null;
}

/* ------------------------------------------------------------------ *
 * flash layout
 * ------------------------------------------------------------------ */

/** One region of a flash layout: a byte offset and the file that goes there. */
export interface FlashRegion {
  address: number;
  name: string;
}

/** The conventional offsets for a chip: a single merged app, and the full set. */
export interface ChipOffsets {
  /** Where a single application binary goes when flashed on its own. */
  app: number;
  /** Where the bootloader goes (equal to `app` for merged-at-0x0 chips). */
  bootloader: number;
  /** Where the partition table goes. */
  partitionTable: number;
  /** The full bootloader, partition table and app layout, in address order. */
  full: FlashRegion[];
}

/**
 * The conventional offsets each family uses, from Espressif's own defaults.
 *
 * The ESP32 and ESP32-S2 keep the second stage bootloader at 0x1000 because the
 * ROM loads it from there. The RISC-V parts (ESP32-C3, ESP32-S3) start the
 * bootloader at 0x0. The ESP8266 has no separate partition table in the modern
 * sense, so a single image goes at 0x0. The partition table sits at 0x8000 and
 * the application at 0x10000 across the ESP32 line.
 */
const OFFSETS: Record<ChipKey, ChipOffsets> = {
  esp32: {
    app: 0x10000,
    bootloader: 0x1000,
    partitionTable: 0x8000,
    full: [
      { address: 0x1000, name: 'bootloader.bin' },
      { address: 0x8000, name: 'partitions.bin' },
      { address: 0x10000, name: 'firmware.bin' },
    ],
  },
  esp32s2: {
    app: 0x10000,
    bootloader: 0x1000,
    partitionTable: 0x8000,
    full: [
      { address: 0x1000, name: 'bootloader.bin' },
      { address: 0x8000, name: 'partitions.bin' },
      { address: 0x10000, name: 'firmware.bin' },
    ],
  },
  esp32s3: {
    app: 0x10000,
    bootloader: 0x0,
    partitionTable: 0x8000,
    full: [
      { address: 0x0, name: 'bootloader.bin' },
      { address: 0x8000, name: 'partitions.bin' },
      { address: 0x10000, name: 'firmware.bin' },
    ],
  },
  esp32c3: {
    app: 0x10000,
    bootloader: 0x0,
    partitionTable: 0x8000,
    full: [
      { address: 0x0, name: 'bootloader.bin' },
      { address: 0x8000, name: 'partitions.bin' },
      { address: 0x10000, name: 'firmware.bin' },
    ],
  },
  esp8266: {
    app: 0x0,
    bootloader: 0x0,
    partitionTable: 0x0,
    full: [{ address: 0x0, name: 'firmware.bin' }],
  },
};

/** The conventional flash offsets for a chip. */
export function defaultOffsetsFor(chip: ChipKey): ChipOffsets {
  const offsets = OFFSETS[chip];
  // Return copies so a caller mutating the layout cannot corrupt the table.
  return {
    app: offsets.app,
    bootloader: offsets.bootloader,
    partitionTable: offsets.partitionTable,
    full: offsets.full.map((r) => ({ ...r })),
  };
}

const OFFSET_FIX =
  'Write one region per line as an offset then a file name, for example "0x10000 firmware.bin". Offsets are hex, with or without the 0x prefix.';

/**
 * Parse a user-entered offset table into regions.
 *
 * Each non-empty line is an offset followed by a file name, for example
 * `0x1000 bootloader.bin`. Blank lines and `#` comments are ignored. Offsets
 * are hex with an optional 0x prefix. When `sizes` is given (the byte length of
 * each region's file, in the same order as the parsed regions), the regions are
 * checked for overlap so a bootloader can never be told to write over the
 * partition table. Throws {@link ToolError} on a bad offset, a missing file
 * name, a size list that does not line up, or an overlap.
 */
export function parseFlashLayout(input: string, sizes?: number[]): FlashRegion[] {
  const regions: FlashRegion[] = [];

  const lines = input.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] as string).trim();
    if (!raw || raw.startsWith('#')) continue;

    const match = raw.match(/^(\S+)\s+(.+)$/);
    if (!match) {
      throw new ToolError(
        'bad-layout-line',
        `Line ${i + 1} ("${raw}") is not an offset followed by a file name.`,
        OFFSET_FIX,
      );
    }

    const [, offsetToken, name] = match as unknown as [string, string, string];
    const cleaned = offsetToken.replace(/^0x/i, '');
    if (!/^[0-9a-f]+$/i.test(cleaned)) {
      throw new ToolError(
        'bad-offset',
        `"${offsetToken}" on line ${i + 1} is not a hex offset.`,
        OFFSET_FIX,
      );
    }

    const address = parseInt(cleaned, 16);
    if (!Number.isSafeInteger(address) || address < 0) {
      throw new ToolError(
        'bad-offset',
        `"${offsetToken}" on line ${i + 1} is out of range for a flash offset.`,
        OFFSET_FIX,
      );
    }

    regions.push({ address, name: name.trim() });
  }

  if (regions.length === 0) {
    throw new ToolError(
      'empty-layout',
      'The offset table is empty.',
      OFFSET_FIX,
    );
  }

  if (sizes !== undefined) {
    if (sizes.length !== regions.length) {
      throw new ToolError(
        'size-mismatch',
        `The offset table has ${regions.length} region${regions.length === 1 ? '' : 's'} but ${sizes.length} file size${sizes.length === 1 ? '' : 's'} were given.`,
        'This is an internal mismatch: every region needs exactly one file behind it.',
      );
    }
    assertNoOverlap(regions, sizes);
  } else {
    assertNoDuplicateAddress(regions);
  }

  return regions;
}

/** Two regions may not be told to start at the same address. */
function assertNoDuplicateAddress(regions: FlashRegion[]): void {
  const seen = new Map<number, string>();
  for (const region of regions) {
    const prior = seen.get(region.address);
    if (prior !== undefined) {
      throw new ToolError(
        'overlap',
        `${region.name} and ${prior} both start at 0x${region.address.toString(16)}.`,
        'Give each region a different offset. Flashing two files to one offset would overwrite the first.',
      );
    }
    seen.set(region.address, region.name);
  }
}

/**
 * With the byte length of each region known, check that no region's bytes run
 * into the start of the next region. This is the check that stops a large
 * application image from silently clobbering the partition table above it.
 */
function assertNoOverlap(regions: FlashRegion[], sizes: number[]): void {
  const ordered = regions
    .map((region, index) => ({ region, size: sizes[index] as number }))
    .sort((a, b) => a.region.address - b.region.address);

  for (let i = 0; i < ordered.length - 1; i++) {
    const current = ordered[i] as { region: FlashRegion; size: number };
    const next = ordered[i + 1] as { region: FlashRegion; size: number };
    const end = current.region.address + current.size;
    if (end > next.region.address) {
      throw new ToolError(
        'overlap',
        `${current.region.name} at 0x${current.region.address.toString(16)} is ${current.size} bytes, which runs to 0x${end.toString(16)} and overlaps ${next.region.name} at 0x${next.region.address.toString(16)}.`,
        'Move one region so their byte ranges do not touch, or use a smaller build. Overlapping writes corrupt whichever file is flashed first.',
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * firmware sanity check
 * ------------------------------------------------------------------ */

/** The first byte of an ESP application or bootloader image. */
export const ESP_IMAGE_MAGIC = 0xe9;

/** A firmware image larger than this is almost certainly not a flash image. */
export const MAX_FIRMWARE_BYTES = 32 * 1024 * 1024;

export interface FirmwareCheck {
  /** True when the first byte is the ESP image magic 0xE9. */
  magic: boolean;
  /** The image byte length. */
  size: number;
  /** Non-blocking notes worth showing before the user commits to flashing. */
  warnings: string[];
}

/**
 * A light sanity check on a firmware image before it is written.
 *
 * The one hard rule is that the file has bytes: an empty file is refused. A
 * missing 0xE9 magic is only a warning, never a block, because a partition
 * table, a merged bin flashed at 0x0, or a raw data blob are all legitimate
 * things to write and none start with 0xE9. Refusing them would make the tool
 * wrong more often than the warning is right.
 */
export function validateFirmware(bytes: Uint8Array, chip: ChipKey): FirmwareCheck {
  if (bytes.length === 0) {
    throw new ToolError(
      'empty-firmware',
      'The firmware file is empty.',
      'Pick a .bin file that actually contains a build. A zero byte file has nothing to flash.',
    );
  }

  const warnings: string[] = [];
  const magic = bytes[0] === ESP_IMAGE_MAGIC;

  if (!magic) {
    warnings.push(
      `This file does not start with the 0xE9 image magic, so it is not a ${CHIP_LABELS[chip]} bootloader or application image. That is fine for a partition table or a merged image flashed at 0x0, but check the offset before flashing.`,
    );
  }

  if (bytes.length > MAX_FIRMWARE_BYTES) {
    warnings.push(
      `This file is ${Math.round(bytes.length / (1024 * 1024))} MB, which is larger than most ${CHIP_LABELS[chip]} boards can hold. Confirm it is the right file and that your board has enough flash.`,
    );
  }

  return { magic, size: bytes.length, warnings };
}

/* ------------------------------------------------------------------ *
 * error humaniser
 * ------------------------------------------------------------------ */

const MANUAL_RESET =
  'If your board has no auto reset circuit, hold the BOOT button, tap the EN or RST button, then release BOOT to force it into the download mode, and connect again.';

export interface HumanError {
  title: string;
  detail: string;
}

/**
 * Turn a raw esptool or Web Serial error into a title and a plain-English fix.
 *
 * esptool surfaces low level failures ("Timed out waiting for packet header",
 * "Failed to connect to Espressif device", "Invalid head of packet") that mean
 * nothing to someone flashing their first board. Each maps to the real world
 * cause and the thing to actually try, and connection failures always include
 * the manual BOOT and EN reset dance, because a board without the auto program
 * circuit is the most common reason a connect never completes.
 */
export function humanFlashError(err: unknown): HumanError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (lower.includes('failed to connect') || lower.includes('no serial data received')) {
    return {
      title: 'Could not talk to the board.',
      detail: `The board did not answer the sync handshake. Check the USB cable carries data and not just power, that the board is in a mode that accepts a flash, and that nothing else holds the port. ${MANUAL_RESET}`,
    };
  }
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return {
      title: 'The board stopped responding.',
      detail: `A packet timed out partway through. This is usually a flaky USB cable or hub, or a baud rate the USB bridge cannot keep up with. Try a shorter cable, a direct USB port, and a lower flash baud such as 115200. ${MANUAL_RESET}`,
    };
  }
  if (lower.includes('invalid head of packet') || lower.includes('wrong boot mode')) {
    return {
      title: 'The board is not in download mode.',
      detail: `The reply was garbled, which usually means the chip booted your existing firmware instead of the download stub. ${MANUAL_RESET}`,
    };
  }
  if (lower.includes('wrong chip') || lower.includes('unsupported') || lower.includes('unexpected chip')) {
    return {
      title: 'This is not the chip you selected.',
      detail:
        'The connected board reports a different chip than the layout expects. Pick the matching chip, or let the tool detect it, so the bootloader and partition offsets are right for this family.',
    };
  }
  if (lower.includes('md5') || lower.includes('verif')) {
    return {
      title: 'The flash did not verify.',
      detail:
        'What was read back does not match what was written, so the flash may be worn or the write was interrupted. Try again, and if it keeps failing at the same offset the flash chip may be failing.',
    };
  }
  if (lower.includes('port is not open') || lower.includes('device has been lost') || lower.includes('the device has been lost')) {
    return {
      title: 'The board was disconnected.',
      detail:
        'The serial port went away mid flash, usually an unplugged cable or a board that reset itself. Plug it back in and start the flash again from the beginning.',
    };
  }

  return {
    title: 'The flash failed.',
    detail: `${message}. ${MANUAL_RESET}`,
  };
}

/* ------------------------------------------------------------------ *
 * binary string conversion
 * ------------------------------------------------------------------ */

/** Chunk size for the binary string conversion, small enough to avoid a call stack blow up on a large image. */
const BINARY_STRING_CHUNK = 0x8000;

/**
 * Convert bytes to a "binary string", one character per byte, as some esptool
 * entry points expect. Done in chunks because
 * `String.fromCharCode(...wholeImage)` overflows the argument stack on a large
 * firmware image. Round trips with {@link binaryStringToBytes}.
 */
export function bytesToBinaryString(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += BINARY_STRING_CHUNK) {
    const chunk = bytes.subarray(i, i + BINARY_STRING_CHUNK);
    out += String.fromCharCode(...chunk);
  }
  return out;
}

/** Inverse of {@link bytesToBinaryString}: one byte per character, low 8 bits. */
export function binaryStringToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    out[i] = text.charCodeAt(i) & 0xff;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

const USAGE_ROWS: Record<string, string> = {
  'How this works':
    'This tool flashes ESP32 family and ESP8266 boards over USB, straight from the browser. Plug the board in, click Connect and flash, pick the port, and it runs Espressif\'s own esptool to identify the chip and write your .bin files. The flasher stubs ship inside the page, so nothing is downloaded when you flash.',
  Chips:
    'It covers the ESP32, ESP32-S2, ESP32-S3, ESP32-C3 and ESP8266. A Raspberry Pi Pico is not serial flashable: it appears as a USB drive and takes a UF2 file by drag and drop, so this tool cannot flash it.',
  Offsets:
    'Single file mode drops your build at the conventional application offset for the chip, 0x10000 on the ESP32 line and 0x0 on the ESP8266. Advanced mode lets you set an offset per file for a full bootloader, partition table and app flash.',
  Browsers:
    'Flashing needs the Web Serial API, which Chromium browsers such as Chrome, Edge, Brave, Arc and Opera ship on desktop, and which Firefox 151 and later also support. The page checks for the API rather than for a browser name.',
  Privacy:
    'Everything runs in this tab: your files and inputs never leave your device. Your firmware is never uploaded anywhere.',
};

/**
 * This tool is panel first: a real serial flash only exists in a live browser
 * session, so `run` returns the usage rows that explain the tool. The tested
 * logic that the panel relies on is the exported helpers above.
 */
export function run(): Record<string, string> {
  return { ...USAGE_ROWS };
}

export default { run } satisfies ToolLogic<string, Record<string, string>>;
