// One-off generator for the tiny deterministic binary sample files referenced
// by uf2-inspector and wasm-inspector's meta.ts examples. Not part of the
// build; run manually with `node scripts/gen-binary-samples.mjs` whenever a
// sample needs to be regenerated. Byte layouts mirror the hand-built fixtures
// already proven correct in each tool's index.test.ts.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const samplesDir = fileURLToPath(new URL("../public/samples/", import.meta.url));

// --------------------------------------------------------------------------
// sample.uf2 — a 3 block RP2040 firmware file, 256 bytes of payload per block
// --------------------------------------------------------------------------

const BLOCK_SIZE = 512;
const MAGIC0 = 0x0a324655;
const MAGIC1 = 0x9e5d5157;
const MAGIC_END = 0x0ab16f30;
const FLAG_FAMILY_ID_PRESENT = 0x00002000;
const RP2040 = 0xe48bff56;

function buildBlock({ targetAddr, payloadSize, blockNo, numBlocks, familyId, data }) {
  const block = new Uint8Array(BLOCK_SIZE);
  const view = new DataView(block.buffer);
  view.setUint32(0, MAGIC0, true);
  view.setUint32(4, MAGIC1, true);
  view.setUint32(8, FLAG_FAMILY_ID_PRESENT, true);
  view.setUint32(12, targetAddr, true);
  view.setUint32(16, payloadSize, true);
  view.setUint32(20, blockNo, true);
  view.setUint32(24, numBlocks, true);
  view.setUint32(28, familyId, true);
  if (data) block.set(data.subarray(0, 476), 32);
  view.setUint32(508, MAGIC_END, true);
  return block;
}

function threeBlockUf2() {
  const blocks = [0, 1, 2].map((i) => {
    // A recognizable byte pattern in the payload rather than all zeros, so an
    // inspected block shows non-trivial data.
    const payload = new Uint8Array(256);
    for (let b = 0; b < payload.length; b++) payload[b] = (i * 37 + b) & 0xff;
    return buildBlock({
      targetAddr: 0x10000000 + i * 256,
      payloadSize: 256,
      blockNo: i,
      numBlocks: 3,
      familyId: RP2040,
      data: payload,
    });
  });
  const out = new Uint8Array(blocks.length * BLOCK_SIZE);
  blocks.forEach((b, i) => out.set(b, i * BLOCK_SIZE));
  return out;
}

writeFileSync(samplesDir + "sample.uf2", threeBlockUf2());

// --------------------------------------------------------------------------
// sample.wasm — a minimal but non-trivial module: one memory, one import,
// one export, so wasm-inspector has real imports/exports/memory to show.
// --------------------------------------------------------------------------

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
// id 2 (import), body size 11: count 1, "env" (3), "log" (3), kind 0 (func), type index 0
const IMPORT_SECTION = [0x02, 0x0b, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x03, 0x6c, 0x6f, 0x67, 0x00, 0x00];
// id 5 (memory), body size 3: count 1, limits flag 0 (min only), min 1 page
const MEMORY_SECTION = [0x05, 0x03, 0x01, 0x00, 0x01];
// id 7 (export), body size 7: count 1, "mem" (3), kind 2 (memory), index 0
const EXPORT_SECTION = [0x07, 0x07, 0x01, 0x03, 0x6d, 0x65, 0x6d, 0x02, 0x00];

const wasmModule = Uint8Array.from([
  ...HEADER,
  ...IMPORT_SECTION,
  ...MEMORY_SECTION,
  ...EXPORT_SECTION,
]);

writeFileSync(samplesDir + "sample.wasm", wasmModule);

console.log(`Wrote ${samplesDir}sample.uf2 (${threeBlockUf2().length} bytes)`);
console.log(`Wrote ${samplesDir}sample.wasm (${wasmModule.length} bytes)`);

// --------------------------------------------------------------------------
// sample.pb — a protobuf message exercising varint, string, nested message,
// repeated, fixed64 double, fixed32 float, and bytes wire types. Layout
// mirrors the PB_ALL fixture in protobuf-decoder/index.test.ts.
// --------------------------------------------------------------------------

// prettier-ignore
const PB_SAMPLE = Uint8Array.from([
  0x08, 0x96, 0x01,                                     // 1: varint 150
  0x12, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f,             // 2: string "hello"
  0x1a, 0x04, 0x08, 0x2a, 0x10, 0x01,                   // 3: nested message { 1: 42, 2: 1 }
  0x20, 0x01,                                           // 4: varint 1
  0x20, 0x02,                                           // 4: varint 2, repeated
  0x29, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f, // 5: fixed64, double 1.0
  0x35, 0x00, 0x00, 0x80, 0x3f,                         // 6: fixed32, float 1.0
]);

writeFileSync(samplesDir + "sample.pb", PB_SAMPLE);
console.log(`Wrote ${samplesDir}sample.pb (${PB_SAMPLE.length} bytes)`);
