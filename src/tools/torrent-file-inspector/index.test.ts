import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildMagnet,
  decodeBencode,
  readTorrent,
  run,
  sanitizePath,
  toBase32,
  type TorrentOpts,
} from "./index";
import { ToolError } from "../types";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/**
 * A minimal bencode writer for fixtures only. Keys are written in the order
 * given, deliberately: some tests need a non canonical key order to prove the
 * info hash follows the file's own bytes rather than a re-encoding.
 */
function benc(value: unknown): string {
  if (typeof value === "number") return `i${value}e`;
  if (typeof value === "string") return `${encoder.encode(value).length}:${value}`;
  if (Array.isArray(value)) return `l${value.map(benc).join("")}e`;
  if (value instanceof Map) {
    let out = "d";
    for (const [key, item] of value) out += `${benc(key)}${benc(item)}`;
    return `${out}e`;
  }
  throw new Error("unsupported fixture value");
}

/** 20 byte digests as latin-1 text, so the fixture stays a plain string. */
function pieces(count: number): string {
  let out = "";
  for (let i = 0; i < count * 20; i++) out += String.fromCharCode((i * 7 + 3) & 0x7f);
  return out;
}

const singleFileTorrent = benc(
  new Map<string, unknown>([
    ["announce", "udp://tracker.example.org:6969/announce"],
    ["creation date", 1754521200],
    ["created by", "fixture"],
    [
      "info",
      new Map<string, unknown>([
        ["length", 3000],
        ["name", "holiday.mp4"],
        ["piece length", 1024],
        ["pieces", pieces(3)],
      ]),
    ],
  ]),
);

const multiFileTorrent = benc(
  new Map<string, unknown>([
    ["announce", "http://primary.example.org/announce"],
    [
      "announce-list",
      [
        ["http://primary.example.org/announce"],
        ["udp://backup.example.net:80/announce", "http://primary.example.org/announce"],
      ],
    ],
    ["comment", "two files"],
    ["creation date", 0],
    ["encoding", "UTF-8"],
    ["url-list", ["https://mirror.example.org/pub/"]],
    [
      "info",
      new Map<string, unknown>([
        [
          "files",
          [
            new Map<string, unknown>([
              ["length", 100],
              ["path", ["docs", "a.txt"]],
            ]),
            new Map<string, unknown>([
              ["length", 900],
              ["path", ["..", "..", "etc", "passwd"]],
            ]),
          ],
        ],
        ["name", "bundle"],
        ["piece length", 512],
        ["pieces", pieces(2)],
        ["private", 1],
      ]),
    ],
  ]),
);

const v2Torrent = benc(
  new Map<string, unknown>([
    ["announce", "http://v2.example.org/announce"],
    [
      "info",
      new Map<string, unknown>([
        [
          "file tree",
          new Map<string, unknown>([
            [
              "notes.txt",
              new Map<string, unknown>([["", new Map<string, unknown>([["length", 4096]])]]),
            ],
            [
              "sub",
              new Map<string, unknown>([
                [
                  "clip.mkv",
                  new Map<string, unknown>([["", new Map<string, unknown>([["length", 60000]])]]),
                ],
              ]),
            ],
          ]),
        ],
        ["meta version", 2],
        ["name", "v2-bundle"],
        ["piece length", 16384],
      ]),
    ],
  ]),
);

const defaults: TorrentOpts = { view: "summary", allFiles: false };

const SAMPLE_PATH = fileURLToPath(
  new URL("../../../public/samples/sample.torrent", import.meta.url),
);

/* ------------------------------------------------------------------ */
/* bencode                                                             */
/* ------------------------------------------------------------------ */

describe("decodeBencode", () => {
  it("decodes the four bencode types with their byte spans", () => {
    const node = decodeBencode(bytes("d3:cow3:moo4:spamli1ei-42eee"));
    expect(node.kind).toBe("dict");
    if (node.kind !== "dict") throw new Error("expected a dict");

    const cow = node.value.get("cow");
    expect(cow?.kind).toBe("bytes");
    if (cow?.kind === "bytes") expect(new TextDecoder().decode(cow.value)).toBe("moo");

    const spam = node.value.get("spam");
    expect(spam?.kind).toBe("list");
    if (spam?.kind === "list") {
      expect(spam.value.map((item) => (item.kind === "int" ? item.value : null))).toEqual([1, -42]);
    }
    expect(node.start).toBe(0);
    expect(node.end).toBe(28);
  });

  it("accepts zero and negative integers but rejects leading zeros and negative zero", () => {
    const zero = decodeBencode(bytes("i0e"));
    expect(zero.kind === "int" && zero.value).toBe(0);

    const negative = decodeBencode(bytes("i-7e"));
    expect(negative.kind === "int" && negative.value).toBe(-7);

    expect(() => decodeBencode(bytes("i03e"))).toThrowError(ToolError);
    expect(() => decodeBencode(bytes("i-0e"))).toThrowError(ToolError);
    expect(() => decodeBencode(bytes("ie"))).toThrowError(ToolError);
  });

  it("handles an empty byte string and deeply nested lists", () => {
    const empty = decodeBencode(bytes("0:"));
    expect(empty.kind === "bytes" && empty.value.length).toBe(0);

    const nested = decodeBencode(bytes("lllll4:deepeeeee"));
    expect(nested.kind).toBe("list");
  });

  it("keeps the first of two duplicate keys", () => {
    const node = decodeBencode(bytes("d1:ai1e1:ai2ee"));
    if (node.kind !== "dict") throw new Error("expected a dict");
    const a = node.value.get("a");
    expect(a?.kind === "int" && a.value).toBe(1);
  });

  it("ignores trailing bytes after the top level value", () => {
    const node = decodeBencode(bytes("d1:ai1eetrailing"));
    expect(node.kind).toBe("dict");
    expect(node.end).toBe(8);
  });

  it("throws on a truncated value", () => {
    expect(() => decodeBencode(bytes("d3:cow3:mo"))).toThrowError(/ends in the middle/);
    expect(() => decodeBencode(bytes("5:abc"))).toThrowError(/ends in the middle/);
  });

  it("throws on a byte that starts no bencoded value", () => {
    expect(() => decodeBencode(bytes("xyz"))).toThrowError(/not the start of a bencoded value/);
  });

  it("throws on a dictionary key that is not a byte string", () => {
    expect(() => decodeBencode(bytes("di1ei2ee"))).toThrowError(ToolError);
  });

  it("throws on empty input", () => {
    expect(() => decodeBencode(new Uint8Array(0))).toThrowError(/No torrent data/);
  });
});

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

describe("sanitizePath", () => {
  it("drops traversal and empty segments", () => {
    expect(sanitizePath(["..", "..", "etc", "passwd"])).toBe("etc/passwd");
    expect(sanitizePath([".", "", "a", "b.txt"])).toBe("a/b.txt");
  });

  it("splits embedded separators and normalizes backslashes", () => {
    expect(sanitizePath(["/abs/path", "file.bin"])).toBe("abs/path/file.bin");
    expect(sanitizePath(["win\\sub", "f.txt"])).toBe("win/sub/f.txt");
  });

  it("falls back to a placeholder when nothing survives", () => {
    expect(sanitizePath(["..", ".."])).toBe("(unnamed)");
  });

  it("strips control characters out of a hostile path", () => {
    const bell = String.fromCharCode(7);
    const nul = String.fromCharCode(0);
    expect(sanitizePath([`a${bell}b`, `c${nul}d.txt`])).toBe("ab/cd.txt");
  });
});

describe("control characters in text fields", () => {
  it("replaces them with spaces rather than passing them through", () => {
    const nul = String.fromCharCode(0);
    const esc = String.fromCharCode(27);
    const nasty = benc(
      new Map<string, unknown>([
        ["comment", `line one${nul}line two`],
        [
          "info",
          new Map<string, unknown>([
            ["length", 1],
            ["name", `clean${esc}name`],
          ]),
        ],
      ]),
    );
    const info = readTorrent(bytes(nasty));
    expect(info.name).toBe("clean name");
    expect(info.comment).toBe("line one line two");
  });
});

describe("toBase32", () => {
  it("encodes a 20 byte digest as 32 unpadded characters", () => {
    const digest = new Uint8Array(20).fill(0);
    expect(toBase32(digest)).toBe("A".repeat(32));
    expect(toBase32(digest)).toHaveLength(32);
  });
});

/* ------------------------------------------------------------------ */
/* reading torrents                                                    */
/* ------------------------------------------------------------------ */

describe("readTorrent", () => {
  it("reads a single file v1 torrent", () => {
    const info = readTorrent(bytes(singleFileTorrent));
    expect(info.name).toBe("holiday.mp4");
    expect(info.version).toBe("v1");
    expect(info.singleFile).toBe(true);
    expect(info.files).toEqual([{ path: "holiday.mp4", length: 3000 }]);
    expect(info.totalSize).toBe(3000);
    expect(info.pieceLength).toBe(1024);
    expect(info.pieceCount).toBe(3);
    expect(info.piecesRagged).toBe(false);
    expect(info.private).toBe(false);
    expect(info.infoHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reads a multi file torrent, flattening and de-duplicating trackers", () => {
    const info = readTorrent(bytes(multiFileTorrent));
    expect(info.singleFile).toBe(false);
    expect(info.files).toEqual([
      { path: "docs/a.txt", length: 100 },
      { path: "etc/passwd", length: 900 },
    ]);
    expect(info.totalSize).toBe(1000);
    expect(info.private).toBe(true);
    // The announce URL repeats in tier 1 and must appear exactly once.
    expect(info.trackers).toEqual([
      "http://primary.example.org/announce",
      "udp://backup.example.net:80/announce",
    ]);
    expect(info.webSeeds).toEqual(["https://mirror.example.org/pub/"]);
    expect(info.createdUnix).toBe(0);
  });

  it("reads a BitTorrent v2 torrent from its file tree", () => {
    const info = readTorrent(bytes(v2Torrent));
    expect(info.version).toBe("v2");
    expect(info.files).toEqual([
      { path: "notes.txt", length: 4096 },
      { path: "sub/clip.mkv", length: 60000 },
    ]);
    expect(info.totalSize).toBe(64096);
    // No flat pieces string on a v2 only torrent.
    expect(info.pieceCount).toBeUndefined();
    expect(info.infoHashV2).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports a hybrid torrent as hybrid", () => {
    const hybrid = benc(
      new Map<string, unknown>([
        [
          "info",
          new Map<string, unknown>([
            [
              "file tree",
              new Map<string, unknown>([["a", new Map([["", new Map([["length", 5]])]])]]),
            ],
            ["length", 5],
            ["meta version", 2],
            ["name", "both"],
            ["piece length", 16384],
            ["pieces", pieces(1)],
          ]),
        ],
      ]),
    );
    const info = readTorrent(bytes(hybrid));
    expect(info.version).toBe("hybrid");
    expect(info.infoHashV2).toBeDefined();
    // A hybrid keeps its v1 view of the files, so the v1 length wins.
    expect(info.totalSize).toBe(5);
  });

  it("flags a pieces field that is not a whole number of digests", () => {
    const ragged = benc(
      new Map<string, unknown>([
        [
          "info",
          new Map<string, unknown>([
            ["length", 10],
            ["name", "odd"],
            ["piece length", 16384],
            ["pieces", "short"],
          ]),
        ],
      ]),
    );
    expect(readTorrent(bytes(ragged)).piecesRagged).toBe(true);
  });

  it("hashes the file's own info bytes, not a re-encoding", () => {
    // Same content, non canonical key order. A re-encoder would normalize this
    // and produce the wrong hash; slicing the original bytes must not.
    const canonical = benc(
      new Map<string, unknown>([
        [
          "info",
          new Map<string, unknown>([
            ["length", 1],
            ["name", "x"],
          ]),
        ],
      ]),
    );
    const shuffled = benc(
      new Map<string, unknown>([
        [
          "info",
          new Map<string, unknown>([
            ["name", "x"],
            ["length", 1],
          ]),
        ],
      ]),
    );
    expect(readTorrent(bytes(canonical)).infoHash).not.toBe(readTorrent(bytes(shuffled)).infoHash);
  });

  it("throws when the top level value is not a dictionary", () => {
    expect(() => readTorrent(bytes("li1ee"))).toThrowError(/not a dictionary/);
  });

  it("throws when there is no info dictionary", () => {
    expect(() => readTorrent(bytes("d8:announce3:abce"))).toThrowError(/no info dictionary/);
  });

  it("throws when info is not a dictionary", () => {
    expect(() => readTorrent(bytes("d4:infoi5ee"))).toThrowError(/not a dictionary/);
  });
});

/* ------------------------------------------------------------------ */
/* magnet                                                              */
/* ------------------------------------------------------------------ */

describe("buildMagnet", () => {
  it("builds a v1 magnet with name, size and trackers", () => {
    const magnet = buildMagnet(readTorrent(bytes(multiFileTorrent)));
    expect(magnet.startsWith("magnet:?xt=urn:btih:")).toBe(true);
    expect(magnet).toContain("dn=bundle");
    expect(magnet).toContain("xl=1000");
    expect(magnet).toContain(`tr=${encodeURIComponent("http://primary.example.org/announce")}`);
  });

  it("uses the btmh topic alone for a v2 only torrent", () => {
    const magnet = buildMagnet(readTorrent(bytes(v2Torrent)));
    expect(magnet).toContain("xt=urn:btmh:1220");
    expect(magnet).not.toContain("urn:btih:");
  });
});

/* ------------------------------------------------------------------ */
/* input handling and views                                            */
/* ------------------------------------------------------------------ */

describe("run", () => {
  it("renders the summary of a real sample file", () => {
    const out = run(new Uint8Array(readFileSync(SAMPLE_PATH)), defaults);
    expect(out["Name"]).toBe("sample-dataset");
    expect(out["Protocol version"]).toBe("v1 (BEP 3)");
    // Cross-checked against node:crypto over the info dict slice.
    expect(out["Info hash (SHA-1 hex)"]).toBe("197560d64a3c7cd04691d4cd17fda111c6191866");
    expect(out["Info hash (base32)"]).toBe("DF2WBVSKHR6NARUR2TGRP7NBCHDBSGDG");
    expect(out["Total size"]).toBe("53 KB (54,272 bytes)");
    expect(out["Files"]).toBe("3");
    expect(out["Pieces"]).toBe("4 SHA-1 digests");
    expect(out["Created"]).toBe("2025-08-06T23:00:00.000Z (unix 1754521200)");
    expect(out["Created by"]).toBe("gen-torrent-sample.mjs");
    expect(out["Trackers"].split("\n")).toEqual([
      "udp://tracker.example.org:6969/announce",
      "http://backup.example.net:8080/announce",
      "wss://tracker.example.dev:443/announce",
    ]);
    expect(out["File list"]).toContain("data/part-001.csv");
  });

  it("caps the file list at 200 entries unless every file is asked for", () => {
    const many = Array.from({ length: 205 }, (_, i) => {
      return new Map<string, unknown>([
        ["length", 1],
        ["path", [`f${i}.bin`]],
      ]);
    });
    const big = benc(
      new Map<string, unknown>([
        [
          "info",
          new Map<string, unknown>([
            ["files", many],
            ["name", "many"],
            ["piece length", 16384],
            ["pieces", pieces(1)],
          ]),
        ],
      ]),
    );

    const capped = run(bytes(big), defaults);
    expect(capped["File list"]).toContain("and 5 more");
    expect(capped["File list"].split("\n")).toHaveLength(201);

    const full = run(bytes(big), { view: "summary", allFiles: true });
    expect(full["File list"]).not.toContain("and 5 more");
    expect(full["File list"].split("\n")).toHaveLength(205);
  });

  it("switches views", () => {
    const files = run(bytes(multiFileTorrent), { view: "files", allFiles: false });
    expect(Object.keys(files)).toEqual(["Name", "Files", "Total size", "File list"]);

    const magnet = run(bytes(multiFileTorrent), { view: "magnet", allFiles: false });
    expect(Object.keys(magnet)).toEqual([
      "Magnet link",
      "Info hash (SHA-1 hex)",
      "Info hash (base32)",
      "Name",
    ]);
  });

  it("reports a trackerless torrent honestly", () => {
    const out = run(bytes(singleFileTorrent.replace("8:announce", "9:announceX")), defaults);
    expect(out["Trackers"]).toBe("none, so this is a trackerless torrent");
  });

  it("accepts a pasted hex dump and a pasted base64 file", () => {
    const raw = readFileSync(SAMPLE_PATH);
    const hex = raw.toString("hex");
    const base64 = raw.toString("base64");
    const expected = "197560d64a3c7cd04691d4cd17fda111c6191866";
    expect(run(hex, defaults)["Info hash (SHA-1 hex)"]).toBe(expected);
    expect(run(base64, defaults)["Info hash (SHA-1 hex)"]).toBe(expected);
  });

  it("accepts literal bencode text", () => {
    const out = run(singleFileTorrent, defaults);
    expect(out["Name"]).toBe("holiday.mp4");
  });

  it("throws on empty input", () => {
    expect(() => run(new Uint8Array(0), defaults)).toThrowError(/No torrent data/);
    expect(() => run("   ", defaults)).toThrowError(/No torrent data/);
  });

  it("throws on text that is not a torrent, with a fix that names the file", () => {
    try {
      run("just some words", defaults);
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("unreadable-input");
      expect((e as ToolError).fix).toMatch(/Drop the .torrent file/);
    }
  });

  it("rejects a file past the size limit", () => {
    const huge = new Uint8Array(64 * 1024 * 1024 + 1);
    huge[0] = 0x64;
    expect(() => run(huge, defaults)).toThrowError(/past the/);
  });
});
