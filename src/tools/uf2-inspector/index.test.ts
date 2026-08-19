import { describe, expect, it } from "vitest";
import {
  BLOCK_SIZE,
  FLAG_EXT_TAGS_PRESENT,
  FLAG_FAMILY_ID_PRESENT,
  FLAG_MD5_PRESENT,
  MAGIC0,
  MAGIC1,
  MAGIC_END,
  familyLabel,
  run,
} from "./index";
import { ToolError } from "../types";

const RP2040 = 0xe48bff56;

interface BlockOpts {
  flags?: number;
  targetAddr?: number;
  payloadSize?: number;
  blockNo?: number;
  numBlocks?: number;
  fileSizeOrFamilyId?: number;
  data?: Uint8Array;
  magic0?: number;
  magic1?: number;
  magicEnd?: number;
}

function buildBlock(opts: BlockOpts = {}): Uint8Array {
  const block = new Uint8Array(BLOCK_SIZE);
  const view = new DataView(block.buffer);
  view.setUint32(0, opts.magic0 ?? MAGIC0, true);
  view.setUint32(4, opts.magic1 ?? MAGIC1, true);
  view.setUint32(8, opts.flags ?? 0, true);
  view.setUint32(12, opts.targetAddr ?? 0, true);
  view.setUint32(16, opts.payloadSize ?? 0, true);
  view.setUint32(20, opts.blockNo ?? 0, true);
  view.setUint32(24, opts.numBlocks ?? 1, true);
  view.setUint32(28, opts.fileSizeOrFamilyId ?? 0, true);
  if (opts.data) block.set(opts.data.subarray(0, 476), 32);
  view.setUint32(508, opts.magicEnd ?? MAGIC_END, true);
  return block;
}

function concatBlocks(blocks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(blocks.length * BLOCK_SIZE);
  blocks.forEach((b, i) => out.set(b, i * BLOCK_SIZE));
  return out;
}

function encodeTag(id: number, value: Uint8Array): Uint8Array {
  const totalLen = 4 + value.length;
  const padded = Math.ceil(totalLen / 4) * 4;
  const out = new Uint8Array(padded);
  out[0] = totalLen;
  out[1] = id & 0xff;
  out[2] = (id >> 8) & 0xff;
  out[3] = (id >> 16) & 0xff;
  out.set(value, 4);
  return out;
}

function toBytesUtf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Builds a simple 3-block contiguous RP2040 file, 256 bytes/block, sequential. */
function threeBlockFile(): Uint8Array {
  const blocks = [0, 1, 2].map((i) =>
    buildBlock({
      flags: FLAG_FAMILY_ID_PRESENT,
      targetAddr: 0x10000000 + i * 256,
      payloadSize: 256,
      blockNo: i,
      numBlocks: 3,
      fileSizeOrFamilyId: RP2040,
    }),
  );
  return concatBlocks(blocks);
}

describe("uf2-inspector: valid 3 block RP2040 file", () => {
  const bytes = threeBlockFile();

  it("reports exact summary rows", () => {
    const out = run(bytes, { view: "summary" });
    expect(out.Blocks).toBe("3 blocks (numBlocks field agrees)");
    expect(out.Families).toBe("RP2040 (0xe48bff56): 3 blocks");
    expect(out.Flags).toBe("family ID present: 3/3");
    expect(out["Address ranges"]).toBe("0x10000000..0x10000300 (768 B)");
    expect(out.Gaps).toBe("none");
    expect(out["Total payload"]).toBe("768 B");
    expect(out["Payload size"]).toBe("256 B per block, consistent across 3 blocks");
    expect(out["Block sequence"]).toBe("sequential 0..2, no gaps or duplicates");
    expect(out["Extension tags"]).toBe("none");
    expect(out["MD5 checksum"]).toBe("not present");
    expect(out.Verdict).toBe("Looks valid");
  });

  it("blocks view lists each block", () => {
    const out = run(bytes, { view: "blocks" });
    expect(out["Block 0"]).toBe(
      "blockNo 0, addr 0x10000000, size 256 B, family RP2040 (0xe48bff56)",
    );
    expect(out["Block 2"]).toBe(
      "blockNo 2, addr 0x10000200, size 256 B, family RP2040 (0xe48bff56)",
    );
  });

  it("defaults to summary view when view is omitted", () => {
    const out = run(bytes, {} as never);
    expect(out.Verdict).toBe("Looks valid");
  });
});

describe("uf2-inspector: family ID flag off", () => {
  it("does not treat fileSize as a family ID", () => {
    const block = buildBlock({ payloadSize: 256, numBlocks: 1, fileSizeOrFamilyId: RP2040 });
    const out = run(block, { view: "summary" });
    expect(out.Families).toBe("none declared (family ID flag not set on any block)");
  });
});

describe("uf2-inspector: gap between blocks", () => {
  it("reports the gap between two non-adjacent runs", () => {
    const b0 = buildBlock({ targetAddr: 0x1000, payloadSize: 256, blockNo: 0, numBlocks: 2 });
    const b1 = buildBlock({ targetAddr: 0x2000, payloadSize: 256, blockNo: 1, numBlocks: 2 });
    const out = run(concatBlocks([b0, b1]), { view: "summary" });
    expect(out["Address ranges"]).toBe("0x00001000..0x00001100 (256 B), 0x00002000..0x00002100 (256 B)");
    expect(out.Gaps).toBe("0x00001100..0x00002000 (3.8 KB gap)");
    expect(out.Verdict).toBe("Looks valid");
  });
});

describe("uf2-inspector: missing block number", () => {
  it("flags the missing block number and fails the verdict", () => {
    const b0 = buildBlock({ blockNo: 0, numBlocks: 3, targetAddr: 0, payloadSize: 256 });
    const b1 = buildBlock({ blockNo: 2, numBlocks: 3, targetAddr: 256, payloadSize: 256 });
    const b2 = buildBlock({ blockNo: 3, numBlocks: 3, targetAddr: 512, payloadSize: 256 });
    const out = run(concatBlocks([b0, b1, b2]), { view: "summary" });
    expect(out["Block sequence"]).toContain("missing: 1");
    expect(out["Block sequence"]).toContain("out of order");
    expect(out.Verdict).toMatch(/Issues found/);
    expect(out.Verdict).toContain("missing block number: 1");
  });
});

describe("uf2-inspector: extension tags", () => {
  it("decodes version, device description, and page size tags", () => {
    const version = encodeTag(0x9fc7bc, toBytesUtf8("1.2.3"));
    const desc = encodeTag(0x650d9d, toBytesUtf8("ACME Toaster mk3"));
    const pageSize = new Uint8Array(4);
    new DataView(pageSize.buffer).setUint32(0, 4096, true);
    const pageSizeTag = encodeTag(0x0be9f7, pageSize);

    const payload = new Uint8Array(4); // payloadSize of 4, already 4-byte aligned
    const data = new Uint8Array(476);
    data.set(payload, 0);
    let offset = 4;
    for (const tag of [version, desc, pageSizeTag]) {
      data.set(tag, offset);
      offset += tag.length;
    }

    const block = buildBlock({
      flags: FLAG_EXT_TAGS_PRESENT,
      payloadSize: 4,
      numBlocks: 1,
      data,
    });
    const out = run(block, { view: "summary" });
    expect(out["Extension tags"]).toBe(
      "Firmware version: 1.2.3; Device description: ACME Toaster mk3; Page size: 4.0 KB",
    );
  });
});

describe("uf2-inspector: block table truncation", () => {
  it("caps the blocks view at 200 rows with a truncation row", () => {
    const total = 201;
    const blocks = Array.from({ length: total }, (_, i) =>
      buildBlock({ blockNo: i, numBlocks: total, targetAddr: i * 256, payloadSize: 256 }),
    );
    const out = run(concatBlocks(blocks), { view: "blocks" });
    expect(out["Block 199"]).toContain("blockNo 199");
    expect(out["Block 200"]).toBeUndefined();
    expect(out["..."]).toBe("1 more block not shown");
  });
});

describe("uf2-inspector: fingerprint SHA tag", () => {
  it("decodes the 0xb46db0 fingerprint tag as hex", () => {
    // The task brief that requested this tool named this tag 0xb46b3d; the
    // upstream microsoft/uf2 spec's actual id is 0xb46db0 (confirmed against
    // the README's own worked example), so that is what is implemented and
    // tested here. A file carrying a literal 0xb46b3d tag still decodes, via
    // the "Unknown tag" fallback below.
    const sha = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]);
    const tag = encodeTag(0xb46db0, sha);
    const data = new Uint8Array(476);
    data.set(tag, 0); // payloadSize 0, already 4-byte aligned
    const block = buildBlock({ flags: FLAG_EXT_TAGS_PRESENT, payloadSize: 0, numBlocks: 1, data });
    const out = run(block, { view: "summary" });
    expect(out["Extension tags"]).toBe("Firmware fingerprint (SHA-2): deadbeef01020304");
  });

  it("falls back to an unknown-tag label for the task brief's literal id", () => {
    const tag = encodeTag(0xb46b3d, new Uint8Array([0xaa, 0xbb]));
    const data = new Uint8Array(476);
    data.set(tag, 0);
    const block = buildBlock({ flags: FLAG_EXT_TAGS_PRESENT, payloadSize: 0, numBlocks: 1, data });
    const out = run(block, { view: "summary" });
    expect(out["Extension tags"]).toBe("Unknown tag 0xb46b3d: 2 bytes: 0xaabb");
  });
});

describe("uf2-inspector: MD5 presence", () => {
  it("reports how many blocks carry the MD5 flag", () => {
    const block = buildBlock({ flags: FLAG_MD5_PRESENT, payloadSize: 256, numBlocks: 1 });
    const out = run(block, { view: "summary" });
    expect(out["MD5 checksum"]).toBe("present on 1/1 block");
  });
});

describe("uf2-inspector: familyLabel", () => {
  it("names a known family and marks an unknown one", () => {
    expect(familyLabel(RP2040)).toBe("RP2040 (0xe48bff56)");
    expect(familyLabel(0xdeadbeef)).toBe("unknown family (0xdeadbeef)");
  });
});

describe("uf2-inspector: errors", () => {
  it("throws empty-input on an empty Uint8Array", () => {
    expect(() => run(new Uint8Array(0), { view: "summary" })).toThrow(ToolError);
    try {
      run(new Uint8Array(0), { view: "summary" });
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("throws empty-input on an empty string", () => {
    try {
      run("   ", { view: "summary" });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("throws bad-encoding on text that is neither hex nor base64", () => {
    try {
      run("not valid at all!!", { view: "summary" });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-encoding");
    }
  });

  it("throws not-uf2 on a wrong magic number, naming the found bytes", () => {
    const bad = buildBlock({ magic0: 0x12345678 });
    try {
      run(bad, { view: "summary" });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("not-uf2");
      expect((e as ToolError).message).toContain("78 56 34 12");
    }
  });

  it("throws truncated when length is not a multiple of 512", () => {
    const oneBlock = buildBlock();
    // A genuinely 600 byte input: one full (valid-magic) block plus 88 extra bytes.
    const bytes600 = new Uint8Array(600);
    bytes600.set(oneBlock, 0);
    try {
      run(bytes600, { view: "summary" });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("truncated");
      expect((e as ToolError).message).toContain("600 bytes");
    }
  });

  it("accepts a hex string encoding of a valid file", () => {
    const bytes = threeBlockFile();
    const hex = bytesToHex(bytes);
    const out = run(hex, { view: "summary" });
    expect(out.Verdict).toBe("Looks valid");
    expect(out.Families).toBe("RP2040 (0xe48bff56): 3 blocks");
  });

  it("accepts a base64 string encoding of a valid file", () => {
    const bytes = threeBlockFile();
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    const base64 = btoa(binary);
    const out = run(base64, { view: "summary" });
    expect(out.Verdict).toBe("Looks valid");
  });
});
