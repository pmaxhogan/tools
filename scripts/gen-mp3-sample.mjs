// One-off generator for public/samples/sample.mp3, the file mp3-tag-editor's
// meta.ts offers as its worked example. Not part of the build; run manually
// with `node scripts/gen-mp3-sample.mjs` whenever the sample needs to be
// regenerated.
//
// The output is fully deterministic: no timestamps, no randomness, so
// regenerating it produces byte identical output and the checked-in file never
// churns. It is a real file, not a stub: an ID3v2.3 tag carrying a hand built
// 16x16 PNG cover, followed by 30 valid MPEG-1 Layer III frames of silence at
// 128 kbps / 44100 Hz, followed by an ID3v1.1 trailer so the fallback path has
// something to read too.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "fflate";

const samplesDir = fileURLToPath(new URL("../public/samples/", import.meta.url));

// --------------------------------------------------------------------------
// A 16x16 PNG cover, built byte by byte
// --------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function be32(value) {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function pngChunk(type, data) {
  const typeBytes = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)));
  const body = concat([typeBytes, data]);
  return concat([be32(data.length), body, be32(crc32(body))]);
}

/** A 16x16 truecolor PNG: a diagonal gradient, so the preview is visibly art. */
function buildCoverPng() {
  const size = 16;
  const raw = new Uint8Array(size * (1 + size * 3));
  let at = 0;
  for (let y = 0; y < size; y++) {
    raw[at++] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      raw[at++] = 24 + x * 12;
      raw[at++] = 40 + y * 10;
      raw[at++] = 200 - (x + y) * 5;
    }
  }

  const ihdr = concat([
    be32(size),
    be32(size),
    new Uint8Array([8, 2, 0, 0, 0]), // 8 bit, truecolor, no interlace
  ]);
  // level 9 with a fixed input is deterministic, and fflate writes no header
  // fields that vary between runs.
  const idat = deflateSync(raw, { level: 9 });

  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

// --------------------------------------------------------------------------
// The ID3v2.3 tag
// --------------------------------------------------------------------------

function latin1(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function id3Frame(id, body) {
  const header = new Uint8Array(10);
  header.set(latin1(id), 0);
  header[4] = (body.length >>> 24) & 0xff;
  header[5] = (body.length >>> 16) & 0xff;
  header[6] = (body.length >>> 8) & 0xff;
  header[7] = body.length & 0xff;
  return concat([header, body]);
}

/** A Latin-1 text frame: one encoding byte, then the text. */
function textFrame(id, text) {
  return id3Frame(id, concat([new Uint8Array([0]), latin1(text)]));
}

function commentFrame(text) {
  return id3Frame(
    "COMM",
    concat([new Uint8Array([0]), latin1("eng"), new Uint8Array([0]), latin1(text)]),
  );
}

function pictureFrame(png) {
  return id3Frame(
    "APIC",
    concat([
      new Uint8Array([0]), // Latin-1 description
      latin1("image/png"),
      new Uint8Array([0]),
      new Uint8Array([3]), // front cover
      latin1("Front cover"),
      new Uint8Array([0]),
      png,
    ]),
  );
}

function syncsafe(value) {
  return new Uint8Array([
    (value >>> 21) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 7) & 0x7f,
    value & 0x7f,
  ]);
}

const PADDING = 1024;

function buildTag() {
  const frames = concat([
    textFrame("TIT2", "Sample Tone"),
    textFrame("TPE1", "Tools Demo"),
    textFrame("TPE2", "Tools Demo"),
    textFrame("TALB", "Sample Files"),
    textFrame("TYER", "2026"),
    textFrame("TRCK", "1/3"),
    textFrame("TCON", "Electronic"),
    textFrame("TCOM", "Nobody"),
    commentFrame("A tiny generated MP3 for trying the tag editor."),
    pictureFrame(buildCoverPng()),
  ]);

  const header = concat([
    latin1("ID3"),
    new Uint8Array([3, 0, 0]),
    syncsafe(frames.length + PADDING),
  ]);
  return concat([header, frames, new Uint8Array(PADDING)]);
}

// --------------------------------------------------------------------------
// The audio: 30 MPEG-1 Layer III frames, 128 kbps, 44100 Hz, joint stereo
// --------------------------------------------------------------------------

const FRAME_COUNT = 30;

function buildAudio() {
  const bitrate = 128;
  const sampleRate = 44100;
  // Layer III frame length: 144 * bitrate / sample rate, plus the padding bit.
  const length = Math.floor((144 * bitrate * 1000) / sampleRate);

  const frames = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const frame = new Uint8Array(length);
    frame[0] = 0xff;
    frame[1] = 0xfb; // MPEG-1, Layer III, no CRC
    frame[2] = 0x90; // bitrate index 9 (128 kbps), sample rate index 0 (44100)
    frame[3] = 0x44; // joint stereo, intensity + MS off, original
    // The rest stays zero: a silent granule, which every decoder accepts.
    frames.push(frame);
  }
  return concat(frames);
}

// --------------------------------------------------------------------------
// The ID3v1.1 trailer
// --------------------------------------------------------------------------

function buildV1() {
  const out = new Uint8Array(128);
  out.set(latin1("TAG"), 0);
  out.set(latin1("Sample Tone"), 3);
  out.set(latin1("Tools Demo"), 33);
  out.set(latin1("Sample Files"), 63);
  out.set(latin1("2026"), 93);
  out.set(latin1("Generated sample"), 97);
  out[125] = 0;
  out[126] = 1; // track 1, which is what makes it ID3v1.1
  out[127] = 52; // Electronic
  return out;
}

const file = concat([buildTag(), buildAudio(), buildV1()]);
writeFileSync(samplesDir + "sample.mp3", file);
console.log(`wrote sample.mp3 (${file.length} bytes)`);
