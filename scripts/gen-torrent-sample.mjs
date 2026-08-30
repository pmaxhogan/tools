// One-off generator for public/samples/sample.torrent, the deterministic
// example file referenced by torrent-file-inspector's meta.ts. Not part of the
// build; run manually with `node scripts/gen-torrent-sample.mjs` whenever the
// sample needs regenerating.
//
// Everything here is fixed: the creation date is a hard coded unix timestamp
// and the piece digests come from an arithmetic pattern, so re-running this
// script always writes byte-identical output. Nothing reads the clock.
//
// The torrent describes files that do not exist anywhere. It is metadata for
// illustration, not a pointer at real data, and its trackers are example.org
// style hostnames that resolve to nothing.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../public/samples/sample.torrent", import.meta.url));

const encoder = new TextEncoder();

/* -------------------------------------------------------------------- */
/* bencode encoder                                                       */
/* -------------------------------------------------------------------- */

/**
 * Encode one value as bencode. Dictionary keys are sorted by raw byte, which
 * bencode requires and which the info hash depends on: a client that re-sorted
 * the keys would compute a different hash for the same torrent.
 *
 * Values: number (integer), string (UTF-8 byte string), Uint8Array (raw byte
 * string), Array (list), Map (dictionary).
 */
function bencode(value) {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error(`bencode holds integers only, got ${value}`);
    return encoder.encode(`i${value}e`);
  }
  if (typeof value === "string") return bencode(encoder.encode(value));
  if (value instanceof Uint8Array) {
    return concat([encoder.encode(`${value.length}:`), value]);
  }
  if (Array.isArray(value)) {
    return concat([encoder.encode("l"), ...value.map(bencode), encoder.encode("e")]);
  }
  if (value instanceof Map) {
    const keys = [...value.keys()].sort(compareByteWise);
    const parts = [encoder.encode("d")];
    for (const key of keys) {
      parts.push(bencode(key), bencode(value.get(key)));
    }
    parts.push(encoder.encode("e"));
    return concat(parts);
  }
  throw new Error(`cannot bencode ${typeof value}`);
}

/** Byte-wise string order, which is what bencode's key sort means. */
function compareByteWise(a, b) {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  const len = Math.min(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    if (ab[i] !== bb[i]) return ab[i] - bb[i];
  }
  return ab.length - bb.length;
}

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/* -------------------------------------------------------------------- */
/* the sample torrent                                                    */
/* -------------------------------------------------------------------- */

const PIECE_LENGTH = 16384;

const FILES = [
  { path: ["docs", "readme.txt"], length: 1024 },
  { path: ["data", "part-001.csv"], length: 32768 },
  { path: ["data", "part-002.csv"], length: 20480 },
];

const TOTAL = FILES.reduce((sum, file) => sum + file.length, 0);
const PIECE_COUNT = Math.ceil(TOTAL / PIECE_LENGTH);

// A recognizable pattern rather than zeros, so the digests look like digests.
// These are not real SHA-1 hashes of real data; nothing here has any data.
function pieceDigests(count) {
  const out = new Uint8Array(count * 20);
  for (let piece = 0; piece < count; piece++) {
    for (let byte = 0; byte < 20; byte++) {
      out[piece * 20 + byte] = (piece * 73 + byte * 11 + 7) & 0xff;
    }
  }
  return out;
}

const info = new Map([
  [
    "files",
    FILES.map(
      (file) =>
        new Map([
          ["length", file.length],
          ["path", file.path],
        ]),
    ),
  ],
  ["name", "sample-dataset"],
  ["piece length", PIECE_LENGTH],
  ["pieces", pieceDigests(PIECE_COUNT)],
  ["private", 0],
]);

const torrent = new Map([
  ["announce", "udp://tracker.example.org:6969/announce"],
  [
    "announce-list",
    [
      ["udp://tracker.example.org:6969/announce"],
      ["http://backup.example.net:8080/announce", "wss://tracker.example.dev:443/announce"],
    ],
  ],
  ["comment", "Sample torrent for tools.maxhogan.dev. It describes no real data."],
  ["created by", "gen-torrent-sample.mjs"],
  // Fixed timestamp: 2025-08-06T23:00:00Z. Never Date.now().
  ["creation date", 1754521200],
  ["encoding", "UTF-8"],
  ["info", info],
]);

const bytes = bencode(torrent);
writeFileSync(OUT, bytes);
console.log(
  `wrote ${OUT} (${bytes.length} bytes, ${FILES.length} files, ${PIECE_COUNT} pieces, ${TOTAL} bytes of content)`,
);
