import { formatBytes } from "@/lib/format";
import { ToolError, type ToolLogic } from "../types";

/**
 * UF2 (USB Flashing Format) inspector.
 *
 * UF2 is Microsoft's format for drag-and-drop firmware flashing (the format
 * behind the RPI-RP2 drive on a Raspberry Pi Pico, and used across most of
 * the Cortex-M and RISC-V microcontroller ecosystem). A UF2 file is a
 * sequence of fixed 512 byte blocks, each self-describing where its 256 (or
 * fewer) payload bytes belong in target flash. This is a hand-rolled binary
 * reader: no dependencies, no DOM, no network.
 *
 * Block layout (all multi-byte fields little-endian):
 *   0   magicStart0   u32   0x0A324655 ("UF2\n")
 *   4   magicStart1   u32   0x9E5D5157
 *   8   flags         u32
 *   12  targetAddr    u32
 *   16  payloadSize   u32
 *   20  blockNo       u32
 *   24  numBlocks     u32
 *   28  fileSize/familyID  u32  (familyID when flag 0x2000 is set)
 *   32  data          476 bytes (payload, optionally followed by tags)
 *   508 magicEnd      u32   0x0AB16F30
 *
 * The family ID table and the extension tag IDs below are taken from the
 * official microsoft/uf2 repository (uf2families.json and README.md). One
 * entry in the brief that requested this tool named the "fingerprint SHA"
 * extension tag as 0xb46b3d; the upstream spec's actual value is 0xb46db0,
 * which is what is implemented here so real-world files decode correctly.
 */

/* ------------------------------------------------------------------ */
/* constants                                                          */
/* ------------------------------------------------------------------ */

export const BLOCK_SIZE = 512;
export const MAGIC0 = 0x0a324655;
export const MAGIC1 = 0x9e5d5157;
export const MAGIC_END = 0x0ab16f30;

export const FLAG_NOT_MAIN_FLASH = 0x00000001;
export const FLAG_FILE_CONTAINER = 0x00001000;
export const FLAG_FAMILY_ID_PRESENT = 0x00002000;
export const FLAG_MD5_PRESENT = 0x00004000;
export const FLAG_EXT_TAGS_PRESENT = 0x00008000;

const FLAG_DEFS: { bit: number; label: string }[] = [
  { bit: FLAG_NOT_MAIN_FLASH, label: "not main flash" },
  { bit: FLAG_FILE_CONTAINER, label: "file container" },
  { bit: FLAG_FAMILY_ID_PRESENT, label: "family ID present" },
  { bit: FLAG_MD5_PRESENT, label: "MD5 checksum present" },
  { bit: FLAG_EXT_TAGS_PRESENT, label: "extension tags present" },
];

const KNOWN_FLAG_MASK = FLAG_DEFS.reduce((mask, f) => mask | f.bit, 0);

const TAG_VERSION = 0x9fc7bc;
const TAG_DEVICE_DESCRIPTION = 0x650d9d;
const TAG_PAGE_SIZE = 0x0be9f7;
const TAG_FINGERPRINT_SHA = 0xb46db0;
const TAG_DEVICE_TYPE_ID = 0xc8a729;

/** Well-known family IDs, from the official uf2families.json. */
export const FAMILIES: Record<number, string> = {
  0xe48bff56: "RP2040",
  0xe48bff57: "RP2xxx absolute (unpartitioned)",
  0xe48bff58: "RP2xxx data partition",
  0xe48bff59: "RP2350 (Arm, Secure)",
  0xe48bff5a: "RP2350 (RISC-V)",
  0xe48bff5b: "RP2350 (Arm, Non-secure)",
  0x68ed2b88: "SAMD21",
  0x1851780a: "SAML21",
  0x55114460: "SAMD51",
  0x1b57745f: "NRF52",
  0x820d9a5f: "NRF52820",
  0x72721d4e: "NRF52832 (xxAA)",
  0x6f752678: "NRF52832 (xxAB)",
  0x621e937a: "NRF52833",
  0xada52840: "NRF52840",
  0x647824b6: "STM32F0",
  0x5ee21072: "STM32F1 (STM32F103)",
  0x5d1a0a2e: "STM32F2",
  0x6b846188: "STM32F3",
  0x57755a57: "STM32F4",
  0x6d0922fa: "STM32F407",
  0x8fb060fe: "STM32F407VG",
  0x06d1097b: "STM32F411xC",
  0x2dc309c5: "STM32F411xE",
  0x53b80f00: "STM32F7",
  0x300f5633: "STM32G0",
  0x4c71240a: "STM32G4",
  0x4e8f1c5d: "STM32H5",
  0x6db66082: "STM32H7",
  0x202e3a91: "STM32L0",
  0x1e1f432d: "STM32L1",
  0x00ff6919: "STM32L4",
  0x04240bdf: "STM32L5",
  0x70d16653: "STM32WB",
  0x21460ff0: "STM32WL",
  0x1c5f21b0: "ESP32",
  0xbfdd4eee: "ESP32-S2",
  0xc47e5767: "ESP32-S3",
  0xd42ba06c: "ESP32-C3",
  0x2b88d29c: "ESP32-C2",
  0x540ddf62: "ESP32-C6",
  0x332726f6: "ESP32-H2",
  0x7eab61ed: "ESP8266",
  0x16573617: "ATMEGA32",
  0x4fb2d5bd: "MIMXRT10XX",
  0x31d228c6: "GD32F350",
  0x9af03e33: "GD32VF103",
  0x2abc77ec: "LPC55",
  0x7f83e793: "KL32L2",
  0x9fffd543: "RTL8710A (AmebaZ)",
  0x22e0d6fc: "RTL8710B (AmebaZ)",
  0xe08f7564: "RTL8720C (AmebaZ2)",
  0x3379cfe2: "RTL8720D (AmebaD)",
  0x5a18069b: "FX2",
  0x51e903a8: "XR809",
  0xde1270b7: "BL602",
  0x7b3ef230: "BK7231N",
  0x675a40b0: "BK7231U",
  0x6a82cc42: "BK7251",
  0x699b62ec: "CH32V",
  0xa0c97b8e: "AT32F415",
  0x7be8976d: "RA4M1",
};

/** Formats a family ID as "Name (0xhhhhhhhh)", or "unknown family (0x..)". */
export function familyLabel(id: number): string {
  const name = FAMILIES[id] ?? "unknown family";
  return `${name} (0x${id.toString(16).padStart(8, "0")})`;
}

/* ------------------------------------------------------------------ */
/* options                                                            */
/* ------------------------------------------------------------------ */

export interface Uf2Opts {
  /** "summary" | "blocks". */
  view: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* input decoding                                                     */
/* ------------------------------------------------------------------ */

function emptyInput(): ToolError {
  return new ToolError(
    "empty-input",
    "Provide a UF2 file.",
    "Drop a .uf2 file, or paste its base64 or hex encoding.",
  );
}

function badEncoding(): ToolError {
  return new ToolError(
    "bad-encoding",
    "This text is not valid base64 or hex.",
    "Paste a UF2 file's base64 or hex encoding, or drop the raw .uf2 file.",
  );
}

function notUf2(bytes: Uint8Array): ToolError {
  const found =
    Array.from(bytes.subarray(0, Math.min(8, bytes.length)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ") || "no bytes";
  return new ToolError(
    "not-uf2",
    `This does not look like a UF2 file. Expected it to start with magic bytes 55 46 32 0a 9e 5d 51 57, found ${found} instead.`,
    "Drop a .uf2 file, or paste its base64 or hex encoding.",
  );
}

function truncatedError(length: number): ToolError {
  const remainder = length % BLOCK_SIZE;
  return new ToolError(
    "truncated",
    `This input is ${length} bytes, which is not a multiple of the 512 byte UF2 block size (${remainder} bytes left over).`,
    "The file looks cut off. Re-download or re-export the .uf2 file.",
  );
}

function hexToBytes(hex: string): Uint8Array | null {
  const compact = hex.replace(/^0[xX]/, "");
  if (compact.length === 0 || compact.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(compact)) return null;
  const out = new Uint8Array(compact.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(compact.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function base64ToBytes(text: string): Uint8Array | null {
  const normal = text.replace(/-/g, "+").replace(/_/g, "/");
  if (normal.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normal)) return null;
  try {
    const binary = atob(normal);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function startsWithMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, 8);
  return view.getUint32(0, true) === MAGIC0 && view.getUint32(4, true) === MAGIC1;
}

/**
 * Accepts raw bytes, a bare hex string (with or without a 0x prefix), or a
 * base64 string. Hex and base64 share an alphabet, so a hex dump is also a
 * syntactically valid (if meaningless) base64 string; rather than guess by
 * shape, both decodings are attempted and the one that produces the UF2
 * magic bytes wins. `bad-encoding` is only thrown when neither decoding is
 * even syntactically valid; a syntactically valid decode with the wrong
 * magic instead surfaces as `not-uf2`, which names what was actually found.
 */
function toBytes(input: Uint8Array | string): Uint8Array {
  if (typeof input !== "string") {
    if (!input || input.length === 0) throw emptyInput();
    return input;
  }

  const compact = input.trim().replace(/\s+/g, "");
  if (compact === "") throw emptyInput();

  const hexBytes = hexToBytes(compact);
  const b64Bytes = base64ToBytes(compact);
  for (const bytes of [hexBytes, b64Bytes]) {
    if (bytes && startsWithMagic(bytes)) return bytes;
  }
  if (hexBytes) return hexBytes;
  if (b64Bytes) return b64Bytes;
  throw badEncoding();
}

/* ------------------------------------------------------------------ */
/* block model                                                        */
/* ------------------------------------------------------------------ */

export interface Uf2Tag {
  id: number;
  label: string;
  value: string;
}

export interface Uf2Block {
  /** Position of this block in the file (0-based). */
  index: number;
  flags: number;
  targetAddr: number;
  payloadSize: number;
  blockNo: number;
  numBlocks: number;
  fileSizeOrFamilyId: number;
  /** Set only when the family ID flag is present on this block. */
  familyId?: number;
  magicOk: boolean;
  magicEndOk: boolean;
  tags: Uf2Tag[];
}

function decodeUtf8TrimNul(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return new TextDecoder("utf-8").decode(bytes.subarray(0, end));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function describeTag(id: number, raw: Uint8Array): Uf2Tag {
  switch (id) {
    case TAG_VERSION:
      return { id, label: "Firmware version", value: decodeUtf8TrimNul(raw) };
    case TAG_DEVICE_DESCRIPTION:
      return { id, label: "Device description", value: decodeUtf8TrimNul(raw) };
    case TAG_PAGE_SIZE: {
      if (raw.length >= 4) {
        const view = new DataView(raw.buffer, raw.byteOffset, 4);
        return { id, label: "Page size", value: formatBytes(view.getUint32(0, true)) };
      }
      return { id, label: "Page size", value: `0x${toHex(raw)}` };
    }
    case TAG_FINGERPRINT_SHA:
      return { id, label: "Firmware fingerprint (SHA-2)", value: toHex(raw) };
    case TAG_DEVICE_TYPE_ID: {
      if (raw.length === 4) {
        const view = new DataView(raw.buffer, raw.byteOffset, 4);
        return { id, label: "Device type ID", value: `0x${view.getUint32(0, true).toString(16)}` };
      }
      if (raw.length === 8) {
        const view = new DataView(raw.buffer, raw.byteOffset, 8);
        const combined = (BigInt(view.getUint32(4, true)) << 32n) | BigInt(view.getUint32(0, true));
        return { id, label: "Device type ID", value: `0x${combined.toString(16)}` };
      }
      return { id, label: "Device type ID", value: `0x${toHex(raw)}` };
    }
    default: {
      const shown = raw.subarray(0, Math.min(raw.length, 16));
      return {
        id,
        label: `Unknown tag 0x${id.toString(16).padStart(6, "0")}`,
        value: `${raw.length} bytes: 0x${toHex(shown)}${raw.length > shown.length ? "..." : ""}`,
      };
    }
  }
}

/**
 * Reads the TLV extension tags stored after the payload in a block's data
 * region (only meaningful when the extension-tags flag is set). Per the UF2
 * spec: tags start 4-byte aligned right after the payload; each tag's first
 * byte is its total size (including that size byte and the 3-byte tag id),
 * followed by the 3-byte little-endian tag id, followed by size-4 value
 * bytes; a size of 0 terminates the list; each tag is itself padded to a
 * 4-byte boundary.
 */
function readExtensionTags(data: Uint8Array, payloadSize: number): { tags: Uf2Tag[]; issue?: string } {
  let offset = Math.ceil(Math.min(payloadSize, data.length) / 4) * 4;
  const tags: Uf2Tag[] = [];
  while (offset < data.length) {
    const size = data[offset];
    if (size === 0) return { tags };
    if (size < 4 || offset + size > data.length) {
      return { tags, issue: "an extension tag has an invalid length" };
    }
    const id = data[offset + 1] | (data[offset + 2] << 8) | (data[offset + 3] << 16);
    const raw = data.subarray(offset + 4, offset + size);
    tags.push(describeTag(id, raw));
    offset += Math.ceil(size / 4) * 4;
  }
  return { tags };
}

function parseBlocks(bytes: Uint8Array): { blocks: Uf2Block[]; tagIssues: string[] } {
  const count = bytes.length / BLOCK_SIZE;
  const blocks: Uf2Block[] = [];
  const tagIssues: string[] = [];

  for (let i = 0; i < count; i++) {
    const off = i * BLOCK_SIZE;
    const view = new DataView(bytes.buffer, bytes.byteOffset + off, BLOCK_SIZE);
    const magic0 = view.getUint32(0, true);
    const magic1 = view.getUint32(4, true);
    const flags = view.getUint32(8, true);
    const targetAddr = view.getUint32(12, true);
    const payloadSize = view.getUint32(16, true);
    const blockNo = view.getUint32(20, true);
    const numBlocks = view.getUint32(24, true);
    const fileSizeOrFamilyId = view.getUint32(28, true);
    const data = bytes.subarray(off + 32, off + 32 + 476);
    const magicEnd = view.getUint32(508, true);

    let tags: Uf2Tag[] = [];
    if ((flags & FLAG_EXT_TAGS_PRESENT) !== 0 && payloadSize <= 476) {
      const result = readExtensionTags(data, payloadSize);
      tags = result.tags;
      if (result.issue) tagIssues.push(`block ${i}: ${result.issue}`);
    }

    blocks.push({
      index: i,
      flags,
      targetAddr,
      payloadSize,
      blockNo,
      numBlocks,
      fileSizeOrFamilyId,
      familyId: (flags & FLAG_FAMILY_ID_PRESENT) !== 0 ? fileSizeOrFamilyId : undefined,
      magicOk: magic0 === MAGIC0 && magic1 === MAGIC1,
      magicEndOk: magicEnd === MAGIC_END,
      tags,
    });
  }

  return { blocks, tagIssues };
}

/* ------------------------------------------------------------------ */
/* analysis                                                           */
/* ------------------------------------------------------------------ */

interface Run {
  start: number;
  end: number;
}

/**
 * Contiguous runs of targetAddr, walked in file order (not sorted by
 * address): this mirrors how a flashing tool actually writes the blocks, so
 * a "gap" here means a real jump in the write sequence, not just an
 * unsorted file.
 */
function computeRuns(blocks: Uf2Block[]): Run[] {
  const runs: Run[] = [];
  for (const b of blocks) {
    const start = b.targetAddr;
    const end = b.targetAddr + b.payloadSize;
    const last = runs[runs.length - 1];
    if (last && last.end === start) {
      last.end = end;
    } else {
      runs.push({ start, end });
    }
  }
  return runs;
}

function hex32(n: number): string {
  return `0x${n.toString(16).padStart(8, "0")}`;
}

interface SequenceCheck {
  missing: number[];
  duplicates: number[];
  outOfOrder: boolean;
}

function checkSequence(blocks: Uf2Block[]): SequenceCheck {
  const numbers = blocks.map((b) => b.blockNo);
  const present = new Set(numbers);
  const missing: number[] = [];
  for (let i = 0; i < blocks.length; i++) if (!present.has(i)) missing.push(i);

  const seen = new Map<number, number>();
  for (const n of numbers) seen.set(n, (seen.get(n) ?? 0) + 1);
  const duplicates = [...seen.entries()].filter(([, c]) => c > 1).map(([n]) => n);

  const outOfOrder = numbers.some((n, i) => n !== i);

  return { missing, duplicates, outOfOrder };
}

function capList(nums: number[], cap = 10): string {
  const shown = nums.slice(0, cap).join(", ");
  return nums.length > cap ? `${shown}, ... (${nums.length} total)` : shown;
}

/* ------------------------------------------------------------------ */
/* rendering                                                          */
/* ------------------------------------------------------------------ */

function blocksRow(blocks: Uf2Block[]): string {
  const count = blocks.length;
  const declared = new Set(blocks.map((b) => b.numBlocks));
  const noun = count === 1 ? "block" : "blocks";
  if (declared.size === 1 && declared.has(count)) {
    return `${count} ${noun} (numBlocks field agrees)`;
  }
  if (declared.size === 1) {
    return `${count} ${noun} (numBlocks field disagrees: blocks claim ${[...declared][0]})`;
  }
  return `${count} ${noun} (numBlocks field disagrees across blocks: ${[...declared].sort((a, b) => a - b).join(", ")})`;
}

function familiesRow(blocks: Uf2Block[]): string {
  const counts = new Map<number, number>();
  let withoutFlag = 0;
  for (const b of blocks) {
    if (b.familyId !== undefined) counts.set(b.familyId, (counts.get(b.familyId) ?? 0) + 1);
    else withoutFlag++;
  }
  if (counts.size === 0) return "none declared (family ID flag not set on any block)";
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `${familyLabel(id)}: ${n} block${n === 1 ? "" : "s"}`);
  if (withoutFlag > 0) parts.push(`${withoutFlag} block${withoutFlag === 1 ? "" : "s"} without a family ID`);
  return parts.join("; ");
}

function flagsRow(blocks: Uf2Block[]): string {
  const total = blocks.length;
  const parts: string[] = [];
  for (const { bit, label } of FLAG_DEFS) {
    const n = blocks.filter((b) => (b.flags & bit) !== 0).length;
    if (n > 0) parts.push(`${label}: ${n}/${total}`);
  }
  const unknownBlocks = blocks.filter((b) => (b.flags & ~KNOWN_FLAG_MASK) !== 0).length;
  if (unknownBlocks > 0) parts.push(`unrecognized flag bits set: ${unknownBlocks}/${total}`);
  return parts.length === 0 ? "no flags set" : parts.join(", ");
}

function rangesRow(runs: Run[]): string {
  if (runs.length === 0) return "none";
  return runs.map((r) => `${hex32(r.start)}..${hex32(r.end)} (${formatBytes(r.end - r.start)})`).join(", ");
}

function gapsRow(runs: Run[]): string {
  if (runs.length <= 1) return "none";
  const parts: string[] = [];
  for (let i = 1; i < runs.length; i++) {
    const prev = runs[i - 1];
    const cur = runs[i];
    if (cur.start > prev.end) {
      parts.push(`${hex32(prev.end)}..${hex32(cur.start)} (${formatBytes(cur.start - prev.end)} gap)`);
    } else if (cur.start < prev.end) {
      parts.push(`overlap or reorder: ${hex32(cur.start)} is before the end of the previous run ${hex32(prev.end)}`);
    }
  }
  return parts.length === 0 ? "none" : parts.join(", ");
}

function payloadConsistencyRow(blocks: Uf2Block[]): string {
  const first = blocks[0].payloadSize;
  const diffIndex = blocks.findIndex((b) => b.payloadSize !== first);
  if (diffIndex === -1) {
    return `${formatBytes(first)} per block, consistent across ${blocks.length} block${blocks.length === 1 ? "" : "s"}`;
  }
  const sizes = [...new Set(blocks.map((b) => b.payloadSize))].sort((a, b) => a - b);
  return `varies (${sizes.map((s) => formatBytes(s)).join(", ")}); first differs at block ${diffIndex}`;
}

function sequenceRow(blocks: Uf2Block[], check: SequenceCheck): string {
  if (check.missing.length === 0 && check.duplicates.length === 0 && !check.outOfOrder) {
    return `sequential 0..${blocks.length - 1}, no gaps or duplicates`;
  }
  const parts: string[] = [];
  if (check.missing.length > 0) parts.push(`missing: ${capList(check.missing)}`);
  if (check.duplicates.length > 0) parts.push(`duplicated: ${capList(check.duplicates)}`);
  if (check.outOfOrder) parts.push("block numbers are out of order in the file");
  return parts.join("; ");
}

function extensionTagsRow(blocks: Uf2Block[]): string {
  const anyFlag = blocks.some((b) => (b.flags & FLAG_EXT_TAGS_PRESENT) !== 0);
  if (!anyFlag) return "none";
  const seen = new Map<string, string>();
  for (const b of blocks) for (const t of b.tags) seen.set(`${t.label} ${t.value}`, `${t.label}: ${t.value}`);
  if (seen.size === 0) return "flag set, but no tags could be decoded";
  return [...seen.values()].join("; ");
}

function md5Row(blocks: Uf2Block[]): string {
  const withFlag = blocks.filter((b) => (b.flags & FLAG_MD5_PRESENT) !== 0).length;
  if (withFlag === 0) return "not present";
  return `present on ${withFlag}/${blocks.length} block${blocks.length === 1 ? "" : "s"}`;
}

function collectIssues(blocks: Uf2Block[], check: SequenceCheck, runs: Run[], tagIssues: string[]): string[] {
  const issues: string[] = [...tagIssues];

  blocks.forEach((b, i) => {
    if (!b.magicOk) issues.push(`block ${i} has a corrupt start-of-block magic`);
    if (!b.magicEndOk) issues.push(`block ${i} has a corrupt end-of-block magic`);
    if (b.payloadSize > 476) {
      issues.push(`block ${i} declares a payload size of ${b.payloadSize} bytes, more than the 476 byte data region`);
    }
  });

  const declared = new Set(blocks.map((b) => b.numBlocks));
  if (!(declared.size === 1 && declared.has(blocks.length))) {
    issues.push("numBlocks field does not agree with the actual block count");
  }
  if (check.missing.length > 0) issues.push(`missing block number${check.missing.length === 1 ? "" : "s"}: ${capList(check.missing)}`);
  if (check.duplicates.length > 0) issues.push(`duplicate block number${check.duplicates.length === 1 ? "" : "s"}: ${capList(check.duplicates)}`);
  if (check.outOfOrder) issues.push("block numbers are out of order relative to file position");

  for (let i = 1; i < runs.length; i++) {
    if (runs[i].start < runs[i - 1].end) issues.push("address ranges overlap or go backward between blocks");
  }

  return issues;
}

function summaryView(blocks: Uf2Block[], tagIssues: string[]): Record<string, string> {
  const runs = computeRuns(blocks);
  const check = checkSequence(blocks);
  const totalPayload = blocks.reduce((sum, b) => sum + b.payloadSize, 0);
  const issues = collectIssues(blocks, check, runs, tagIssues);

  return {
    Blocks: blocksRow(blocks),
    Families: familiesRow(blocks),
    Flags: flagsRow(blocks),
    "Address ranges": rangesRow(runs),
    Gaps: gapsRow(runs),
    "Total payload": formatBytes(totalPayload),
    "Payload size": payloadConsistencyRow(blocks),
    "Block sequence": sequenceRow(blocks, check),
    "Extension tags": extensionTagsRow(blocks),
    "MD5 checksum": md5Row(blocks),
    Verdict: issues.length === 0 ? "Looks valid" : `Issues found: ${issues.join("; ")}`,
  };
}

const BLOCKS_VIEW_CAP = 200;

function blocksView(blocks: Uf2Block[]): Record<string, string> {
  const out: Record<string, string> = {};
  const shown = blocks.slice(0, BLOCKS_VIEW_CAP);
  shown.forEach((b) => {
    const family = b.familyId !== undefined ? `, family ${familyLabel(b.familyId)}` : "";
    out[`Block ${b.index}`] = `blockNo ${b.blockNo}, addr ${hex32(b.targetAddr)}, size ${formatBytes(b.payloadSize)}${family}`;
  });
  if (blocks.length > BLOCKS_VIEW_CAP) {
    const remaining = blocks.length - BLOCKS_VIEW_CAP;
    out["..."] = `${remaining} more block${remaining === 1 ? "" : "s"} not shown`;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* entry point                                                        */
/* ------------------------------------------------------------------ */

export function run(input: Uint8Array | string, opts: Uf2Opts): Record<string, string> {
  const bytes = toBytes(input);
  if (bytes.length >= 8 && !startsWithMagic(bytes)) throw notUf2(bytes);
  if (bytes.length % BLOCK_SIZE !== 0) throw truncatedError(bytes.length);

  const { blocks, tagIssues } = parseBlocks(bytes);
  switch (opts?.view) {
    case "blocks":
      return blocksView(blocks);
    default:
      return summaryView(blocks, tagIssues);
  }
}

export default { run } satisfies ToolLogic<Uint8Array | string, Record<string, string>, Uf2Opts>;
