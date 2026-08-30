// One-off generator for the two archive samples referenced by
// archive-viewer's meta.ts examples. Not part of the build; run manually with
// `node scripts/gen-archive-sample.mjs` whenever a sample needs regenerating.
//
// Both outputs are byte-for-byte reproducible on any machine. Two separate
// things had to be pinned to get that:
//
//  1. fflate stamps the *current* time into every zip local header and gzip
//     header unless told otherwise, so a fixed mtime is passed explicitly
//     everywhere and the tar headers are built here with the same constant.
//  2. A zip stores MS-DOS date fields, and fflate derives them from the
//     *local* calendar components of that mtime. Running this in Chicago and
//     in London would therefore write different bytes even with the mtime
//     pinned. Forcing the zone to UTC before the first Date call removes the
//     last source of drift. (gzip and tar both store plain epoch seconds and
//     were never affected.)
process.env.TZ = "UTC";

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync, zipSync } from "fflate";

const samplesDir = fileURLToPath(new URL("../public/samples/", import.meta.url));

/** 2024-03-14T09:26:53Z. Constant, so the samples are reproducible. */
const MTIME = Date.UTC(2024, 2, 14, 9, 26, 53);
const MTIME_SECONDS = Math.floor(MTIME / 1000);

const encoder = new TextEncoder();
const text = (s) => encoder.encode(s);

// --------------------------------------------------------------------------
// Shared contents: a few text files, one nested directory, one compressible
// file big enough that the ratio column shows something interesting.
// --------------------------------------------------------------------------

const README = `# Sample archive

This little archive exists so the Archive Viewer has something to open on a
first visit. Everything in it is plain text.

Contents:
  README.md          this file
  data/notes.txt     a short note
  data/reading.csv   a few rows of numbers
  logs/app.log       a repetitive log, so compression has something to do
`;

const NOTES = `Packing list
------------
1. tent
2. stove
3. the good coffee
4. a book you will not read
`;

const CSV = `station,depth_m,temp_c,recorded
alpha,12,4.1,2024-03-11
bravo,48,3.6,2024-03-12
charlie,105,2.9,2024-03-13
delta,240,2.2,2024-03-14
`;

// Deliberately repetitive: deflate squeezes this to a few percent, which makes
// the per entry compression column worth looking at.
const LOG = Array.from(
  { length: 400 },
  (_, i) =>
    `2024-03-14T09:${String(20 + (i % 40)).padStart(2, "0")}:00Z INFO  worker=${i % 8} handled request id=${1000 + i} in 12ms`,
).join("\n");

const FILES = [
  ["README.md", README],
  ["data/notes.txt", NOTES],
  ["data/reading.csv", CSV],
  ["logs/app.log", LOG],
];

// --------------------------------------------------------------------------
// sample.zip
// --------------------------------------------------------------------------

function buildZip() {
  const input = {};
  for (const [path, body] of FILES) {
    input[path] = [text(body), { mtime: MTIME }];
  }
  return zipSync(input, { level: 6, mtime: MTIME });
}

// --------------------------------------------------------------------------
// sample.tar.gz: ustar headers built by hand, then one gzip member over them
// --------------------------------------------------------------------------

const BLOCK = 512;

function writeAscii(block, at, value, length) {
  const bytes = text(value);
  for (let i = 0; i < length; i++) block[at + i] = i < bytes.length ? bytes[i] : 0;
}

/** An octal tar field: digits, then a NUL, right aligned with leading zeros. */
function writeOctal(block, at, value, length) {
  const digits = value.toString(8).padStart(length - 1, "0");
  writeAscii(block, at, digits, length - 1);
  block[at + length - 1] = 0;
}

function tarHeader({ name, size, mode, typeflag }) {
  const block = new Uint8Array(BLOCK);
  writeAscii(block, 0, name, 100);
  writeOctal(block, 100, mode, 8);
  writeOctal(block, 108, 0, 8); // uid
  writeOctal(block, 116, 0, 8); // gid
  writeOctal(block, 124, size, 12);
  writeOctal(block, 136, MTIME_SECONDS, 12);
  block[156] = typeflag.charCodeAt(0);
  writeAscii(block, 257, "ustar", 6);
  writeAscii(block, 263, "00", 2);
  writeAscii(block, 265, "sample", 32); // uname
  writeAscii(block, 297, "sample", 32); // gname

  // The checksum is computed with its own eight bytes read as spaces, then
  // written back as six octal digits, a NUL and a space.
  for (let i = 148; i < 156; i++) block[i] = 32;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += block[i];
  writeAscii(block, 148, sum.toString(8).padStart(6, "0"), 6);
  block[154] = 0;
  block[155] = 32;
  return block;
}

function buildTar() {
  const parts = [];
  const push = (block) => parts.push(block);

  for (const dir of ["data/", "logs/"]) {
    push(tarHeader({ name: dir, size: 0, mode: 0o755, typeflag: "5" }));
  }
  for (const [path, body] of FILES) {
    const data = text(body);
    push(tarHeader({ name: path, size: data.length, mode: 0o644, typeflag: "0" }));
    const padded = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
    padded.set(data);
    push(padded);
  }
  // Two zero blocks close the archive, then padding out to a 10240 byte record.
  push(new Uint8Array(BLOCK * 2));

  const total = parts.reduce((n, part) => n + part.length, 0);
  const record = Math.ceil(total / 10240) * 10240;
  const tar = new Uint8Array(record);
  let at = 0;
  for (const part of parts) {
    tar.set(part, at);
    at += part.length;
  }
  return tar;
}

// --------------------------------------------------------------------------

const zip = buildZip();
writeFileSync(samplesDir + "sample.zip", zip);

const targz = gzipSync(buildTar(), { level: 6, mtime: MTIME, filename: "sample.tar" });
writeFileSync(samplesDir + "sample.tar.gz", targz);

console.log(`Wrote ${samplesDir}sample.zip (${zip.length} bytes)`);
console.log(`Wrote ${samplesDir}sample.tar.gz (${targz.length} bytes)`);
