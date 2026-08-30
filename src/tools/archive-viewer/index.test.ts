import { gzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  archivePayload,
  buildTree,
  decodeTextPreview,
  detectFormat,
  formatRatio,
  imageTypeFor,
  isTextPath,
  listArchive,
  looksBinary,
  packEntries,
  readEntry,
  readEntryFrom,
  run,
  sanitizePath,
  type ArchiveEntry,
} from "./index";
import { ToolError } from "../types";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (s: string) => encoder.encode(s);

/**
 * Every fixture pins an mtime. fflate stamps the current time otherwise, which
 * would make the date assertions below depend on when the suite ran.
 */
const MTIME = Date.UTC(2024, 2, 14, 9, 26, 53);
/** What tar and gzip round trip to: both store plain epoch seconds. */
const MTIME_ISO = "2024-03-14T09:26:53Z";

/**
 * What a *zip* round trips to, which is a different string and deliberately so.
 *
 * A zip stores MS-DOS date fields, which carry no timezone and only two second
 * resolution, and fflate fills them from the local calendar components of the
 * mtime. The reader emits those fields verbatim with no Z suffix, since the
 * format never recorded a zone to convert from. Reading is therefore fully
 * timezone independent, but *writing* the fixture is not, so the expectation is
 * derived the same way fflate derives it rather than hard coded.
 */
function expectedZipIso(ms: number): string {
  const at = new Date(ms);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return [
    `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`,
    `T${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(Math.floor(at.getSeconds() / 2) * 2)}`,
  ].join("");
}

const ZIP_ISO = expectedZipIso(MTIME);

const README = "# readme\nhello from inside the archive\n";
const NOTES = "one\ntwo\nthree\n";
/** Repetitive on purpose, so deflate actually shrinks it. */
const LOG = "ping pong ".repeat(400);

function sampleZip(): Uint8Array {
  return zipSync(
    {
      "readme.md": [bytes(README), { mtime: MTIME }],
      "data/notes.txt": [bytes(NOTES), { mtime: MTIME }],
      "logs/app.log": [bytes(LOG), { mtime: MTIME }],
    },
    { level: 6, mtime: MTIME },
  );
}

/**
 * Append an archive level comment to a zip. fflate has no option for one (its
 * `comment` is a per entry field), so the end of central directory record's
 * comment length is patched here directly. This also pushes that record away
 * from the end of the file, which is what the reader's backward scan is for.
 */
function withComment(zip: Uint8Array, comment: string): Uint8Array {
  const text = bytes(comment);
  const out = new Uint8Array(zip.length + text.length);
  out.set(zip);
  out.set(text, zip.length);
  const eocd = zip.length - 22;
  out[eocd + 20] = text.length & 0xff;
  out[eocd + 21] = (text.length >> 8) & 0xff;
  return out;
}

const BLOCK = 512;

function writeAscii(block: Uint8Array, at: number, value: string, length: number): void {
  const raw = bytes(value);
  for (let i = 0; i < length; i++) block[at + i] = i < raw.length ? raw[i]! : 0;
}

function writeOctal(block: Uint8Array, at: number, value: number, length: number): void {
  writeAscii(block, at, value.toString(8).padStart(length - 1, "0"), length - 1);
  block[at + length - 1] = 0;
}

interface TarHeaderInit {
  name: string;
  size: number;
  typeflag?: string;
  prefix?: string;
  linkname?: string;
  mode?: number;
  /** Omit the ustar magic to force detection through the checksum alone. */
  magic?: boolean;
  /** Corrupt the checksum, to exercise the truncated-archive warning. */
  breakChecksum?: boolean;
}

function tarHeader(init: TarHeaderInit): Uint8Array {
  const block = new Uint8Array(BLOCK);
  writeAscii(block, 0, init.name, 100);
  writeOctal(block, 100, init.mode ?? 0o644, 8);
  writeOctal(block, 108, 0, 8);
  writeOctal(block, 116, 0, 8);
  writeOctal(block, 124, init.size, 12);
  writeOctal(block, 136, Math.floor(MTIME / 1000), 12);
  block[156] = (init.typeflag ?? "0").charCodeAt(0);
  if (init.linkname) writeAscii(block, 157, init.linkname, 100);
  if (init.magic !== false) {
    writeAscii(block, 257, "ustar", 6);
    writeAscii(block, 263, "00", 2);
  }
  if (init.prefix) writeAscii(block, 345, init.prefix, 155);

  for (let i = 148; i < 156; i++) block[i] = 32;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += block[i]!;
  if (init.breakChecksum) sum += 1;
  writeAscii(block, 148, sum.toString(8).padStart(6, "0"), 6);
  block[154] = 0;
  block[155] = 32;
  return block;
}

function padTo512(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
  out.set(data);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function tarFile(name: string, body: string, extra: Partial<TarHeaderInit> = {}): Uint8Array[] {
  const data = bytes(body);
  return [tarHeader({ name, size: data.length, ...extra }), padTo512(data)];
}

function sampleTar(): Uint8Array {
  return concat([
    tarHeader({ name: "data/", size: 0, typeflag: "5", mode: 0o755 }),
    ...tarFile("readme.md", README),
    ...tarFile("data/notes.txt", NOTES),
    new Uint8Array(BLOCK * 2),
  ]);
}

/* ------------------------------------------------------------------ */
/* detection                                                           */
/* ------------------------------------------------------------------ */

describe("detectFormat", () => {
  it("recognizes zip, tar and gzip by their bytes", () => {
    expect(detectFormat(sampleZip())).toBe("zip");
    expect(detectFormat(sampleTar())).toBe("tar");
    expect(detectFormat(gzipSync(bytes("hi"), { mtime: MTIME }))).toBe("gz");
  });

  it("rejects bytes that are no archive at all", () => {
    expect(() =>
      detectFormat(bytes("just some words, not an archive at all"), "notes.txt"),
    ).toThrow(ToolError);
    try {
      detectFormat(bytes("just some words, not an archive at all"), "notes.txt");
    } catch (e) {
      expect((e as ToolError).code).toBe("unsupported-archive");
      expect((e as ToolError).message).toContain("notes.txt");
      expect((e as ToolError).fix).toContain("7z");
    }
  });
});

/* ------------------------------------------------------------------ */
/* zip                                                                 */
/* ------------------------------------------------------------------ */

describe("listArchive on a zip", () => {
  const archive = listArchive(sampleZip(), "sample.zip");

  it("lists every entry with sizes, dates and methods", () => {
    expect(archive.format).toBe("zip");
    expect(archive.formatLabel).toBe("zip");
    expect(archive.fileCount).toBe(3);
    expect(archive.entries.map((e) => e.path).sort()).toEqual([
      "data/notes.txt",
      "logs/app.log",
      "readme.md",
    ]);

    const readme = archive.entries.find((e) => e.path === "readme.md")!;
    expect(readme.size).toBe(README.length);
    expect(readme.modified).toBe(ZIP_ISO);
    expect(readme.isDirectory).toBe(false);
    expect(readme.encrypted).toBe(false);
    expect(readme.unsafe).toBe(false);
  });

  it("reports a real compression ratio on a compressible entry", () => {
    const log = archive.entries.find((e) => e.path === "logs/app.log")!;
    expect(log.method).toBe("deflate");
    expect(log.compressedSize).toBeLessThan(log.size / 4);
    expect(log.ratio).toBeGreaterThan(0.7);
    expect(formatRatio(log)).toMatch(/^9\d% smaller$/);
  });

  it("totals the contents and the archive itself separately", () => {
    expect(archive.totalSize).toBe(README.length + NOTES.length + LOG.length);
    expect(archive.totalCompressedSize).toBeLessThan(archive.totalSize);
    expect(archive.archiveSize).toBe(sampleZip().length);
    expect(archive.warnings).toEqual([]);
  });

  it("builds a tree with the directories the zip only implied", () => {
    expect(archive.tree.map((n) => n.name)).toEqual(["data", "logs", "readme.md"]);
    const data = archive.tree.find((n) => n.name === "data")!;
    expect(data.isDirectory).toBe(true);
    // The zip stores no "data/" entry; the tree creates it from the file path.
    expect(data.entry).toBeUndefined();
    expect(data.fileCount).toBe(1);
    expect(data.size).toBe(NOTES.length);
    expect(data.children.map((n) => n.name)).toEqual(["notes.txt"]);
  });

  it("reads a stored and a deflated entry back byte for byte", () => {
    const source = sampleZip();
    const readme = archive.entries.find((e) => e.path === "readme.md")!;
    const log = archive.entries.find((e) => e.path === "logs/app.log")!;
    expect(decoder.decode(readEntry(source, readme))).toBe(README);
    expect(decoder.decode(readEntry(source, log))).toBe(LOG);
  });

  it("keeps the archive comment and still finds the record behind it", () => {
    const commented = withComment(
      zipSync({ "a.txt": [bytes("a"), { mtime: MTIME }] }, { mtime: MTIME }),
      "packed by hand",
    );
    const archive = listArchive(commented);
    expect(archive.comment).toBe("packed by hand");
    // The end of central directory record is no longer the last thing in the
    // file, which is exactly the case the backward scan exists for.
    expect(archive.entries.map((e) => e.path)).toEqual(["a.txt"]);
  });
});

describe("zip edge cases", () => {
  it("keeps an explicit directory entry and marks it as one", () => {
    const archive = listArchive(
      zipSync(
        {
          "docs/": [new Uint8Array(0), { mtime: MTIME }],
          "docs/a.txt": [bytes("a"), { mtime: MTIME }],
        },
        { mtime: MTIME },
      ),
    );
    const dir = archive.entries.find((e) => e.rawPath === "docs/")!;
    expect(dir.isDirectory).toBe(true);
    expect(dir.kind).toBe("directory");
    expect(archive.directoryCount).toBe(1);
    expect(archive.fileCount).toBe(1);
    // The tree reuses the stored entry rather than inventing a second node.
    expect(archive.tree).toHaveLength(1);
    expect(archive.tree[0]!.entry).toBe(dir);
  });

  it("refuses a zip whose end of central directory record is gone", () => {
    const truncated = sampleZip().slice(0, 60);
    expect(() => listArchive(truncated)).toThrow(ToolError);
    try {
      listArchive(truncated);
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-zip");
    }
  });

  it("refuses to read an entry compressed with a method it cannot inflate", () => {
    const archive = listArchive(sampleZip());
    const entry: ArchiveEntry = { ...archive.entries[0]!, methodId: 93, method: "zstd" };
    expect(() => readEntry(sampleZip(), entry)).toThrow(/zstd/);
    try {
      readEntry(sampleZip(), entry);
    } catch (e) {
      expect((e as ToolError).code).toBe("entry-unsupported");
    }
  });

  it("refuses to read a password protected entry", () => {
    const archive = listArchive(sampleZip());
    const entry: ArchiveEntry = { ...archive.entries[0]!, encrypted: true };
    try {
      readEntry(sampleZip(), entry);
      expect.unreachable("an encrypted entry must not read");
    } catch (e) {
      expect((e as ToolError).code).toBe("entry-encrypted");
      expect((e as ToolError).fix).toContain("password");
    }
  });
});

/* ------------------------------------------------------------------ */
/* zip slip                                                            */
/* ------------------------------------------------------------------ */

describe("path sanitization", () => {
  it("strips traversal, absolute roots and drive letters", () => {
    expect(sanitizePath("docs/readme.md")).toEqual({ path: "docs/readme.md", unsafe: false });
    expect(sanitizePath("../../etc/passwd")).toEqual({ path: "etc/passwd", unsafe: true });
    expect(sanitizePath("/etc/shadow")).toEqual({ path: "etc/shadow", unsafe: true });
    expect(sanitizePath("C:\\Windows\\evil.dll")).toEqual({
      path: "Windows/evil.dll",
      unsafe: true,
    });
    expect(sanitizePath("./a/./b")).toEqual({ path: "a/b", unsafe: false });
    expect(sanitizePath("../..")).toEqual({ path: "(unnamed)", unsafe: true });
  });

  it("flags a hostile entry in the listing and still shows what it claimed", () => {
    const archive = listArchive(
      zipSync({ "../../etc/passwd": [bytes("root:x:0:0"), { mtime: MTIME }] }, { mtime: MTIME }),
    );
    const entry = archive.entries[0]!;
    expect(entry.path).toBe("etc/passwd");
    expect(entry.rawPath).toBe("../../etc/passwd");
    expect(entry.unsafe).toBe(true);
    expect(archive.warnings.join(" ")).toContain("outside the archive root");
    // The cleaned path is what a save dialog would ever see.
    expect(
      readEntry(
        zipSync({ "../../etc/passwd": [bytes("root:x:0:0"), { mtime: MTIME }] }, { mtime: MTIME }),
        entry,
      ).length,
    ).toBe(10);
  });
});

/* ------------------------------------------------------------------ */
/* tar                                                                 */
/* ------------------------------------------------------------------ */

/**
 * One pax extended header record, `<length> <key=value>` plus a newline, where
 * the length counts its own digits and is therefore a fixed point rather than
 * something that can be measured up front. Lengths are in UTF-8 bytes, not
 * characters, which starts to matter as soon as a path holds an accent.
 */
function paxRecord(content: string): string {
  const inner = bytes(content).length + 2; // one space, one newline
  let total = inner + 1;
  while (String(total).length + inner !== total) total = String(total).length + inner;
  return `${total} ${content}\n`;
}

describe("listArchive on a tar", () => {
  it("reads ustar headers, directories and file bodies", () => {
    const tar = sampleTar();
    const archive = listArchive(tar, "sample.tar");
    expect(archive.format).toBe("tar");
    expect(archive.fileCount).toBe(2);
    expect(archive.directoryCount).toBe(1);

    const notes = archive.entries.find((e) => e.path === "data/notes.txt")!;
    expect(notes.size).toBe(NOTES.length);
    expect(notes.modified).toBe(MTIME_ISO);
    expect(notes.mode).toBe("644");
    expect(notes.method).toBe("stored");
    expect(decoder.decode(readEntry(tar, notes))).toBe(NOTES);
  });

  it("joins the ustar prefix field onto the name", () => {
    const tar = concat([
      ...tarFile("deep.txt", "x", { prefix: "a/very/long/prefix" }),
      new Uint8Array(BLOCK * 2),
    ]);
    expect(listArchive(tar).entries[0]!.path).toBe("a/very/long/prefix/deep.txt");
  });

  it("resolves a GNU long name from its own L entry", () => {
    const longName = `nested/${"segment/".repeat(14)}finally.txt`;
    expect(longName.length).toBeGreaterThan(100);
    const nameBody = bytes(`${longName}\0`);
    const tar = concat([
      tarHeader({ name: "././@LongLink", size: nameBody.length, typeflag: "L" }),
      padTo512(nameBody),
      ...tarFile("truncated-name-ignored", "deep contents"),
      new Uint8Array(BLOCK * 2),
    ]);

    const archive = listArchive(tar);
    expect(archive.entries).toHaveLength(1);
    expect(archive.entries[0]!.path).toBe(longName);
    expect(decoder.decode(readEntry(tar, archive.entries[0]!))).toBe("deep contents");
  });

  it("resolves a pax path, size and mtime from an extended header", () => {
    const path = "pax/unicode-name-\u00e9\u00e8.txt";
    const body = "pax body";
    const records = ["path=" + path, "mtime=1710408413", "size=" + body.length]
      .map(paxRecord)
      .join("");
    const paxBody = bytes(records);

    const tar = concat([
      tarHeader({ name: "PaxHeaders/0", size: paxBody.length, typeflag: "x" }),
      padTo512(paxBody),
      ...tarFile("placeholder.txt", body),
      new Uint8Array(BLOCK * 2),
    ]);

    const archive = listArchive(tar);
    expect(archive.entries).toHaveLength(1);
    const entry = archive.entries[0]!;
    expect(entry.rawPath).toBe(path);
    expect(entry.size).toBe(body.length);
    expect(entry.modified).toBe("2024-03-14T09:26:53Z");
    expect(decoder.decode(readEntry(tar, entry))).toBe(body);
  });

  it("records a symlink and its target instead of a body", () => {
    const tar = concat([
      tarHeader({ name: "link", size: 0, typeflag: "2", linkname: "../outside/target" }),
      new Uint8Array(BLOCK * 2),
    ]);
    const entry = listArchive(tar).entries[0]!;
    expect(entry.kind).toBe("symlink");
    expect(entry.linkTarget).toBe("../outside/target");
    expect(entry.size).toBe(0);
  });

  it("stops at a corrupt header and says so instead of inventing entries", () => {
    const tar = concat([
      ...tarFile("good.txt", "fine"),
      tarHeader({ name: "bad.txt", size: 4, breakChecksum: true, magic: false }),
      padTo512(bytes("junk")),
      new Uint8Array(BLOCK * 2),
    ]);
    const archive = listArchive(tar);
    expect(archive.entries.map((e) => e.path)).toEqual(["good.txt"]);
    expect(archive.warnings.join(" ")).toContain("failed its checksum");
  });
});

/* ------------------------------------------------------------------ */
/* gzip and tar.gz                                                     */
/* ------------------------------------------------------------------ */

describe("gzip", () => {
  it("reads a gzipped tar as a tar", () => {
    const source = gzipSync(sampleTar(), { level: 6, mtime: MTIME });
    const archive = listArchive(source, "sample.tar.gz");
    expect(archive.format).toBe("tar.gz");
    expect(archive.formatLabel).toBe("gzipped tar");
    expect(archive.fileCount).toBe(2);
    const notes = archive.entries.find((e) => e.path === "data/notes.txt")!;
    expect(decoder.decode(readEntry(source, notes))).toBe(NOTES);
  });

  it("reads a single file gzip and takes the name from the header", () => {
    const source = gzipSync(bytes(README), { level: 6, mtime: MTIME, filename: "readme.md" });
    const archive = listArchive(source, "readme.md.gz");
    expect(archive.format).toBe("gz");
    expect(archive.entries).toHaveLength(1);
    const entry = archive.entries[0]!;
    expect(entry.path).toBe("readme.md");
    expect(entry.size).toBe(README.length);
    expect(entry.modified).toBe(MTIME_ISO);
    expect(decoder.decode(readEntry(source, entry))).toBe(README);
  });

  it("falls back to the archive name when the gzip header stores none", () => {
    const source = gzipSync(bytes("plain body"), { level: 6, mtime: MTIME });
    expect(listArchive(source, "notes.txt.gz").entries[0]!.path).toBe("notes.txt");
    expect(listArchive(source).entries[0]!.path).toBe("decompressed");
  });

  it("refuses a truncated gzip stream", () => {
    const source = gzipSync(bytes(LOG), { level: 6, mtime: MTIME });
    const truncated = source.slice(0, source.length - 40);
    // Keep a plausible trailer so the size guard passes and the inflate fails.
    truncated.set([0, 0, 0, 0], truncated.length - 4);
    try {
      listArchive(truncated);
      expect.unreachable("a truncated gzip must not read");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-gzip");
    }
  });

  it("refuses a gzip whose trailer promises more than the tab will hold", () => {
    const source = gzipSync(bytes("small"), { level: 6, mtime: MTIME });
    const bomb = source.slice();
    // ISIZE is the last four bytes, little endian: claim about 3.2 GB.
    bomb[bomb.length - 4] = 0x00;
    bomb[bomb.length - 3] = 0x00;
    bomb[bomb.length - 2] = 0x00;
    bomb[bomb.length - 1] = 0xc0;
    try {
      listArchive(bomb);
      expect.unreachable("a declared 3 GB expansion must be refused");
    } catch (e) {
      expect((e as ToolError).code).toBe("unpacked-too-large");
      expect((e as ToolError).fix).toContain("gunzip");
    }
  });

  it("refuses a gzip header with an impossible compression method", () => {
    const source = gzipSync(bytes("small"), { level: 6, mtime: MTIME });
    const broken = source.slice();
    broken[2] = 3;
    try {
      listArchive(broken);
      expect.unreachable("only method 8 exists");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-gzip");
    }
  });

  it("inflates once for a payload the caller then slices many times", () => {
    const source = gzipSync(sampleTar(), { level: 6, mtime: MTIME });
    const archive = listArchive(source);
    const payload = archivePayload(source, "tar.gz");
    for (const entry of archive.entries.filter((e) => !e.isDirectory)) {
      expect(readEntryFrom(payload, entry).length).toBe(entry.size);
    }
  });
});

/* ------------------------------------------------------------------ */
/* guards                                                              */
/* ------------------------------------------------------------------ */

describe("input guards", () => {
  it("asks for a file rather than failing on nothing", () => {
    try {
      listArchive(new Uint8Array(0));
      expect.unreachable("empty input must throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
      expect((e as ToolError).fix).toContain(".zip");
    }
  });

  it("refuses an archive past the in-tab size limit", () => {
    // A sparse typed array of the declared length, never actually filled.
    const huge = { length: 501 * 1024 * 1024 } as unknown as Uint8Array;
    try {
      listArchive(huge);
      expect.unreachable("an oversize archive must be refused");
    } catch (e) {
      expect((e as ToolError).code).toBe("archive-too-large");
      expect((e as ToolError).message).toContain("500");
    }
  });

  it("refuses to read a directory as a file", () => {
    const tar = sampleTar();
    const dir = listArchive(tar).entries.find((e) => e.isDirectory)!;
    try {
      readEntry(tar, dir);
      expect.unreachable("a directory has no contents");
    } catch (e) {
      expect((e as ToolError).code).toBe("entry-is-directory");
    }
  });
});

/* ------------------------------------------------------------------ */
/* repacking and preview helpers                                       */
/* ------------------------------------------------------------------ */

describe("packEntries", () => {
  it("round trips a set of files through a rebuilt zip", () => {
    const packed = packEntries(
      [
        { path: "readme.md", data: bytes(README) },
        { path: "data/notes.txt", data: bytes(NOTES) },
      ],
      MTIME,
    );
    const archive = listArchive(packed);
    expect(archive.entries.map((e) => e.path).sort()).toEqual(["data/notes.txt", "readme.md"]);
    const readme = archive.entries.find((e) => e.path === "readme.md")!;
    expect(readme.modified).toBe(ZIP_ISO);
    expect(decoder.decode(readEntry(packed, readme))).toBe(README);
  });

  it("is reproducible when the caller pins the time", () => {
    const files = [{ path: "a.txt", data: bytes("a") }];
    expect(packEntries(files, MTIME)).toEqual(packEntries(files, MTIME));
  });
});

describe("preview helpers", () => {
  it("recognizes text and image entries by extension", () => {
    expect(isTextPath("src/index.ts")).toBe(true);
    expect(isTextPath("notes/todo.md")).toBe(true);
    expect(isTextPath("bin/app.exe")).toBe(false);
    expect(imageTypeFor("art/logo.PNG")).toBe("image/png");
    expect(imageTypeFor("art/photo.jpeg")).toBe("image/jpeg");
    expect(imageTypeFor("art/logo.psd")).toBeUndefined();
  });

  it("caps a text preview and says it was cut", () => {
    const long = decodeTextPreview(bytes("x".repeat(50)), 10);
    expect(long.text).toBe("xxxxxxxxxx");
    expect(long.truncated).toBe(true);
    const short = decodeTextPreview(bytes("hi"), 10);
    expect(short).toEqual({ text: "hi", truncated: false });
  });

  it("spots binary content by its NUL bytes", () => {
    expect(looksBinary(bytes("plain text"))).toBe(false);
    expect(looksBinary(new Uint8Array([0x89, 0x50, 0x00, 0x01]))).toBe(true);
  });
});

describe("buildTree", () => {
  it("returns nothing for an empty archive", () => {
    expect(buildTree([])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

describe("run", () => {
  it("summarizes a zip as labeled rows", () => {
    const out = run(sampleZip());
    expect(out.Format).toBe("zip");
    expect(out.Contents).toBe("3 files, 0 directories");
    expect(out.Uncompressed).toBe(out.Uncompressed);
    expect(out.Entries).toContain("readme.md");
    expect(out.Entries).toContain(ZIP_ISO);
    expect(out.Compression).toMatch(/smaller than the contents$/);
    expect(out.Warnings).toBeUndefined();
  });

  it("draws a tree, a flat list and bare paths on request", () => {
    const tree = run(sampleZip(), { view: "tree" });
    expect(tree.Tree).toContain("|-- data/");
    expect(tree.Tree).toContain("|   `-- notes.txt");

    const list = run(sampleZip(), { view: "list" });
    expect(list.Entries!.split("\n")).toHaveLength(3);

    const paths = run(sampleZip(), { view: "paths" });
    expect(paths).toEqual({ Paths: "data/notes.txt\nlogs/app.log\nreadme.md" });
  });

  it("honors the sort and the entry limit", () => {
    const bySize = run(sampleZip(), { view: "paths", sort: "size" });
    expect(bySize.Paths!.split("\n")[0]).toBe("logs/app.log");

    const capped = run(sampleZip(), { view: "list", limit: 1 });
    expect(capped.Entries).toContain("and 2 more entries");

    // Out of range limits clamp to the nearest legal one rather than throwing.
    expect(run(sampleZip(), { view: "list", limit: -5 }).Entries).toBe(capped.Entries);
    expect(run(sampleZip(), { view: "list", limit: 9999999 }).Entries).not.toContain("and 2 more");
  });

  it("accepts pasted text only to tell the user it is not an archive", () => {
    expect(() => run("hello, this is not an archive")).toThrow(ToolError);
  });

  it("surfaces warnings alongside the listing", () => {
    const out = run(zipSync({ "../escape.txt": [bytes("x"), { mtime: MTIME }] }, { mtime: MTIME }));
    expect(out.Warnings).toContain("outside the archive root");
  });
});
