import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  audioBytesOf,
  buildId3,
  buildId3v1,
  parseId3,
  parseId3v1,
  readStreamInfo,
  resolveGenre,
  run,
  type EditableTag,
  type Id3Picture,
} from "./index";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function utf16le(text: string): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    out[2 + i * 2] = text.charCodeAt(i) & 0xff;
    out[3 + i * 2] = text.charCodeAt(i) >> 8;
  }
  return out;
}

function plainSize(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function syncsafe(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 21) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 7) & 0x7f,
    value & 0x7f,
  ]);
}

/** A four character frame with a plain (v2.3) or syncsafe (v2.4) size. */
function frame(id: string, body: Uint8Array, sync = false, flags = 0): Uint8Array {
  return concat([
    latin1(id),
    sync ? syncsafe(body.length) : plainSize(body.length),
    new Uint8Array([(flags >> 8) & 0xff, flags & 0xff]),
    body,
  ]);
}

function textBody(text: string, encoding = 0): Uint8Array {
  const bytes = encoding === 1 ? utf16le(text) : latin1(text);
  return concat([new Uint8Array([encoding]), bytes]);
}

/** One silent MPEG-1 Layer III frame, 128 kbps at 44100 Hz. */
function mpegFrame(): Uint8Array {
  const out = new Uint8Array(417);
  out[0] = 0xff;
  out[1] = 0xfb;
  out[2] = 0x90;
  out[3] = 0x44;
  return out;
}

function audio(frames = 4): Uint8Array {
  return concat(Array.from({ length: frames }, mpegFrame));
}

/** An ID3v2 tag around a run of already-built frames. */
function tag(major: number, frames: Uint8Array, flags = 0, padding = 0): Uint8Array {
  const body = concat([frames, new Uint8Array(padding)]);
  return concat([latin1("ID3"), new Uint8Array([major, 0, flags]), syncsafe(body.length), body]);
}

function v1Trailer(overrides: Partial<{ track: number; genre: number }> = {}): Uint8Array {
  const out = new Uint8Array(128);
  out.set(latin1("TAG"), 0);
  out.set(latin1("Trailer Title"), 3);
  out.set(latin1("Trailer Artist"), 33);
  out.set(latin1("Trailer Album"), 63);
  out.set(latin1("1999"), 93);
  out.set(latin1("Old school"), 97);
  if (overrides.track !== undefined) {
    out[125] = 0;
    out[126] = overrides.track;
  }
  out[127] = overrides.genre ?? 17;
  return out;
}

const BLANK: EditableTag = {
  title: "",
  artist: "",
  albumArtist: "",
  album: "",
  year: "",
  track: "",
  disc: "",
  genre: "",
  composer: "",
  comment: "",
};

/* ------------------------------------------------------------------ */
/* parseId3: ID3v2.3                                                   */
/* ------------------------------------------------------------------ */

describe("parseId3 on ID3v2.3", () => {
  const file = concat([
    tag(
      3,
      concat([
        frame("TIT2", textBody("Midnight Drive")),
        frame("TPE1", textBody("The Nightliners")),
        frame("TALB", textBody("Interstate")),
        frame("TYER", textBody("2004")),
        frame("TRCK", textBody("7/12")),
        frame("TCON", textBody("(17)Rock")),
        frame(
          "COMM",
          concat([
            new Uint8Array([0]),
            latin1("eng"),
            new Uint8Array([0]),
            latin1("Ripped at home"),
          ]),
        ),
      ]),
      0,
      64,
    ),
    audio(),
  ]);

  it("reads the common text frames", () => {
    const info = parseId3(file);
    expect(info.version).toBe("ID3v2.3.0");
    expect(info.major).toBe(3);
    expect(info.tag.title).toBe("Midnight Drive");
    expect(info.tag.artist).toBe("The Nightliners");
    expect(info.tag.album).toBe("Interstate");
    expect(info.tag.year).toBe("2004");
    expect(info.tag.track).toBe("7/12");
  });

  it("resolves a parenthesized genre reference with a refinement", () => {
    expect(parseId3(file).tag.genre).toBe("Rock");
  });

  it("reads the comment past its language and description", () => {
    const info = parseId3(file);
    expect(info.tag.comment).toBe("Ripped at home");
    const comm = info.frames.find((f) => f.id === "COMM");
    expect(comm?.language).toBe("eng");
    expect(comm?.description).toBe("");
  });

  it("stops at the padding rather than reading it as a frame", () => {
    const info = parseId3(file);
    expect(info.frames).toHaveLength(7);
    expect(info.warnings).toEqual([]);
  });

  it("points audioOffset at the first byte after the tag", () => {
    const info = parseId3(file);
    expect(info.audioOffset).toBe(info.tagSize);
    expect(audioBytesOf(file, info)[0]).toBe(0xff);
    expect(info.audioSize).toBe(417 * 4);
  });
});

/* ------------------------------------------------------------------ */
/* parseId3: ID3v2.4                                                   */
/* ------------------------------------------------------------------ */

describe("parseId3 on ID3v2.4", () => {
  it("reads syncsafe frame sizes and TDRC", () => {
    const file = concat([
      tag(
        4,
        concat([
          frame("TIT2", textBody("Syncsafe"), true),
          frame("TDRC", textBody("2019-04-02T18:00"), true),
          frame("TPE1", textBody("Later Writer"), true),
        ]),
      ),
      audio(),
    ]);
    const info = parseId3(file);
    expect(info.version).toBe("ID3v2.4.0");
    expect(info.tag.title).toBe("Syncsafe");
    expect(info.tag.year).toBe("2019");
    expect(info.tag.artist).toBe("Later Writer");
  });

  it("recovers when a v2.4 writer stored a plain frame size", () => {
    // A 200 byte body: syncsafe would read it as 200 too, so the value has to
    // pass 127 in one of its low bytes to tell the two readings apart.
    const body = textBody("x".repeat(199));
    const file = concat([
      tag(4, concat([frame("TIT2", body, false), frame("TPE1", textBody("Recovered"), true)])),
      audio(),
    ]);
    const info = parseId3(file);
    expect(info.tag.artist).toBe("Recovered");
  });

  it("skips the data length indicator on a v2.4 frame that declares one", () => {
    const body = textBody("Indicated");
    const withIndicator = concat([plainSize(body.length), body]);
    const file = concat([tag(4, frame("TIT2", withIndicator, true, 0x0001)), audio()]);
    expect(parseId3(file).tag.title).toBe("Indicated");
  });

  it("reports an encrypted frame instead of decoding noise", () => {
    const file = concat([tag(4, frame("TIT2", textBody("secret"), true, 0x0004)), audio()]);
    const info = parseId3(file);
    expect(info.frames[0]?.encrypted).toBe(true);
    expect(info.frames[0]?.value).toBeUndefined();
    expect(info.warnings[0]).toContain("encrypted");
  });
});

/* ------------------------------------------------------------------ */
/* encodings and unsynchronization                                     */
/* ------------------------------------------------------------------ */

describe("text encodings", () => {
  it("decodes UTF-16 with a little endian byte order mark", () => {
    const file = concat([tag(3, frame("TIT2", textBody("Åke Sjölin", 1))), audio()]);
    expect(parseId3(file).tag.title).toBe("Åke Sjölin");
  });

  it("decodes UTF-16BE without a mark and UTF-8", () => {
    const be = new Uint8Array([0x00, 0x4b, 0x00, 0x79, 0x00, 0x6f]); // "Kyo"
    const utf8 = new TextEncoder().encode("日本語");
    const file = concat([
      tag(
        3,
        concat([
          frame("TIT2", concat([new Uint8Array([2]), be])),
          frame("TALB", concat([new Uint8Array([3]), utf8])),
        ]),
      ),
      audio(),
    ]);
    const info = parseId3(file);
    expect(info.tag.title).toBe("Kyo");
    expect(info.tag.album).toBe("日本語");
  });
});

describe("unsynchronization", () => {
  it("undoes the whole-tag scheme flagged in the v2.3 header", () => {
    // "ÿ" is 0xFF in Latin-1, so the writer inserts a 0x00 after it.
    const body = textBody("Aÿ B");
    const unsynced = concat([
      latin1("TIT2"),
      plainSize(body.length),
      new Uint8Array([0, 0]),
      concat([
        body.subarray(0, 3),
        new Uint8Array([0x00]), // the inserted byte
        body.subarray(3),
      ]),
    ]);
    const file = concat([tag(3, unsynced, 0x80), audio()]);
    const info = parseId3(file);
    expect(info.flags.unsynchronized).toBe(true);
    expect(info.tag.title).toBe("Aÿ B");
  });

  it("undoes the per-frame scheme flagged on a v2.4 frame", () => {
    const body = textBody("Cÿ D");
    const padded = concat([body.subarray(0, 3), new Uint8Array([0x00]), body.subarray(3)]);
    const file = concat([tag(4, frame("TIT2", padded, true, 0x0002)), audio()]);
    const info = parseId3(file);
    expect(info.frames[0]?.unsynchronized).toBe(true);
    expect(info.tag.title).toBe("Cÿ D");
  });
});

/* ------------------------------------------------------------------ */
/* extended header, v2.2, cover art                                    */
/* ------------------------------------------------------------------ */

describe("headers and older versions", () => {
  it("skips a v2.3 extended header", () => {
    const extended = concat([plainSize(6), new Uint8Array([0, 0]), plainSize(0)]);
    const file = concat([
      tag(3, concat([extended, frame("TIT2", textBody("Behind an extended header"))]), 0x40),
      audio(),
    ]);
    const info = parseId3(file);
    expect(info.flags.extendedHeader).toBe(true);
    expect(info.tag.title).toBe("Behind an extended header");
  });

  it("skips a v2.4 extended header", () => {
    const extended = concat([syncsafe(6), new Uint8Array([1, 0])]);
    const file = concat([
      tag(4, concat([extended, frame("TIT2", textBody("Modern extended"), true)]), 0x40),
      audio(),
    ]);
    expect(parseId3(file).tag.title).toBe("Modern extended");
  });

  it("counts a v2.4 footer in the tag size", () => {
    const frames = frame("TIT2", textBody("Footed"), true);
    const file = concat([
      latin1("ID3"),
      new Uint8Array([4, 0, 0x10]),
      syncsafe(frames.length),
      frames,
      latin1("3DI"),
      new Uint8Array([4, 0, 0x10]),
      syncsafe(frames.length),
      audio(),
    ]);
    const info = parseId3(file);
    expect(info.flags.footer).toBe(true);
    expect(info.tagSize).toBe(10 + frames.length + 10);
    expect(info.audioOffset).toBe(info.tagSize);
  });

  it("maps ID3v2.2's three character frame ids", () => {
    const body = textBody("Ancient");
    const v22Frame = concat([latin1("TT2"), new Uint8Array([0, 0, body.length]), body]);
    const file = concat([tag(2, v22Frame), audio()]);
    const info = parseId3(file);
    expect(info.tag.title).toBe("Ancient");
    expect(info.frames[0]?.rawId).toBe("TT2");
    expect(info.frames[0]?.id).toBe("TIT2");
  });

  it("reads APIC cover art and prefers the front cover", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const apic = (pictureType: number, description: string) =>
      concat([
        new Uint8Array([0]),
        latin1("image/png"),
        new Uint8Array([0, pictureType]),
        latin1(description),
        new Uint8Array([0]),
        png,
      ]);
    const file = concat([
      tag(3, concat([frame("APIC", apic(4, "Back")), frame("APIC", apic(3, "Front"))])),
      audio(),
    ]);
    const info = parseId3(file);
    expect(info.cover?.mime).toBe("image/png");
    expect(info.cover?.pictureType).toBe(3);
    expect(info.cover?.typeLabel).toBe("Front cover");
    expect(info.cover?.description).toBe("Front");
    expect(Array.from(info.cover?.bytes ?? [])).toEqual(Array.from(png));
  });
});

/* ------------------------------------------------------------------ */
/* ID3v1 and untagged files                                            */
/* ------------------------------------------------------------------ */

describe("ID3v1", () => {
  it("falls back to the trailer when there is no ID3v2 tag", () => {
    const file = concat([audio(), v1Trailer({ track: 4 })]);
    const info = parseId3(file);
    expect(info.version).toBe("ID3v1.1");
    expect(info.tag.title).toBe("Trailer Title");
    expect(info.tag.artist).toBe("Trailer Artist");
    expect(info.tag.track).toBe("4");
    expect(info.tag.genre).toBe("Rock");
    expect(info.v1?.version).toBe("1.1");
  });

  it("treats a comment that fills all 30 bytes as ID3v1.0", () => {
    const out = v1Trailer();
    out.set(latin1("x".repeat(30)), 97);
    const info = parseId3(concat([audio(), out]));
    expect(info.v1?.version).toBe("1.0");
    expect(info.v1?.track).toBeUndefined();
  });

  it("keeps the trailer out of the audio size", () => {
    const file = concat([audio(), v1Trailer({ track: 1 })]);
    expect(parseId3(file).audioSize).toBe(417 * 4);
  });

  it("reads a TAG+ extended block when one precedes the trailer", () => {
    const ext = new Uint8Array(227);
    ext.set(latin1("TAG+"), 0);
    ext.set(latin1(" (the long version)"), 4);
    ext.set(latin1("Orchestral"), 185);
    const file = concat([audio(), ext, v1Trailer({ track: 1 })]);
    const info = parseId3(file);
    expect(info.v1?.extended?.title).toBe("(the long version)");
    expect(info.v1?.extended?.genre).toBe("Orchestral");
    expect(info.audioSize).toBe(417 * 4);
  });

  it("returns an empty tag for an MP3 with no tags at all", () => {
    const info = parseId3(audio());
    expect(info.version).toBe("none");
    expect(info.tagSize).toBe(0);
    expect(info.tag).toEqual(BLANK);
    expect(info.stream?.bitrate).toBe(128);
  });

  it("parseId3v1 returns undefined for a file with no trailer", () => {
    expect(parseId3v1(audio())).toBeUndefined();
    expect(parseId3v1(new Uint8Array(4))).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* stream info                                                         */
/* ------------------------------------------------------------------ */

describe("readStreamInfo", () => {
  it("describes an MPEG-1 Layer III stream and estimates its length", () => {
    const bytes = audio(100);
    const stream = readStreamInfo(bytes, 0, bytes.length);
    expect(stream?.codec).toBe("MPEG-1 Layer III");
    expect(stream?.bitrate).toBe(128);
    expect(stream?.sampleRate).toBe(44100);
    expect(stream?.channelMode).toBe("Joint stereo");
    expect(stream?.vbr).toBe(false);
    expect(stream?.durationSeconds).toBeCloseTo(2.606, 2);
  });

  it("returns undefined when there is no frame sync to find", () => {
    expect(readStreamInfo(new Uint8Array(2048), 0, 2048)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* genre resolution                                                    */
/* ------------------------------------------------------------------ */

describe("resolveGenre", () => {
  it("handles every shape a tagger writes", () => {
    expect(resolveGenre("Rock")).toBe("Rock");
    expect(resolveGenre("17")).toBe("Rock");
    expect(resolveGenre("(17)")).toBe("Rock");
    expect(resolveGenre("(17)Rock")).toBe("Rock");
    expect(resolveGenre("(17)(20)")).toBe("Rock / Alternative");
    expect(resolveGenre("(RX)")).toBe("Remix");
    expect(resolveGenre("")).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/* building                                                            */
/* ------------------------------------------------------------------ */

describe("buildId3", () => {
  const tagged: EditableTag = {
    title: "Rebuilt",
    artist: "Writer",
    albumArtist: "Various",
    album: "Output",
    year: "2026",
    track: "3/9",
    disc: "1",
    genre: "Ambient",
    composer: "Someone",
    comment: "Written by the tag editor",
  };

  it("round-trips every field through parseId3", () => {
    const built = buildId3(tagged, audio());
    const info = parseId3(built);
    expect(info.version).toBe("ID3v2.3.0");
    expect(info.tag).toEqual(tagged);
  });

  it("keeps the audio bytes identical and strips the old tag", () => {
    const original = concat([tag(3, frame("TIT2", textBody("Old"))), audio(), v1Trailer()]);
    const before = parseId3(original);
    const built = buildId3(tagged, audioBytesOf(original, before));
    const after = parseId3(built);
    expect(after.tag.title).toBe("Rebuilt");
    expect(after.v1).toBeUndefined();
    expect(Array.from(audioBytesOf(built, after))).toEqual(
      Array.from(audioBytesOf(original, before)),
    );
  });

  it("writes 1 KB of padding by default", () => {
    const built = buildId3(BLANK, audio());
    expect(parseId3(built).tagSize).toBe(10 + 1024);
    expect(parseId3(built).frames).toHaveLength(0);
  });

  it("switches to UTF-16 only when Latin-1 cannot hold the text", () => {
    const latinOnly = parseId3(buildId3({ ...BLANK, title: "Cafe" }, audio()));
    const wide = parseId3(buildId3({ ...BLANK, title: "日本" }, audio()));
    expect(latinOnly.tag.title).toBe("Cafe");
    expect(wide.tag.title).toBe("日本");
    // The Latin-1 frame is one byte per character, the UTF-16 one is two plus
    // a byte order mark, so the sizes have to differ this way round.
    expect(latinOnly.frames[0]?.size).toBe(5);
    expect(wide.frames[0]?.size).toBe(7);
  });

  it("writes and re-reads cover art", () => {
    const cover: Id3Picture = {
      mime: "image/jpeg",
      pictureType: 3,
      typeLabel: "Front cover",
      description: "Sleeve",
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]),
    };
    const info = parseId3(buildId3(tagged, audio(), { cover }));
    expect(info.cover?.mime).toBe("image/jpeg");
    expect(info.cover?.description).toBe("Sleeve");
    expect(Array.from(info.cover?.bytes ?? [])).toEqual(Array.from(cover.bytes));
  });

  it("drops the cover when null is passed", () => {
    const info = parseId3(buildId3(tagged, audio(), { cover: null }));
    expect(info.cover).toBeUndefined();
  });

  it("appends an ID3v1.1 trailer on request", () => {
    const built = buildId3(tagged, audio(), { writeId3v1: true });
    const info = parseId3(built);
    expect(info.v1?.title).toBe("Rebuilt");
    expect(info.v1?.track).toBe(3);
    expect(info.v1?.genre).toBe("Ambient");
    expect(info.audioSize).toBe(417 * 4);
  });

  it("rejects an oversized cover", () => {
    const cover: Id3Picture = {
      mime: "image/png",
      pictureType: 3,
      typeLabel: "Front cover",
      description: "",
      bytes: new Uint8Array(17 * 1024 * 1024),
    };
    expect(() => buildId3(BLANK, audio(), { cover })).toThrowError(ToolError);
    try {
      buildId3(BLANK, audio(), { cover });
    } catch (e) {
      expect((e as ToolError).code).toBe("cover-too-large");
    }
  });

  it("rejects nonsense padding", () => {
    expect(() => buildId3(BLANK, audio(), { padding: -1 })).toThrowError(/padding must be/);
    try {
      buildId3(BLANK, audio(), { padding: 5_000_000 });
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid-padding");
    }
  });
});

describe("buildId3v1", () => {
  it("truncates long fields to their fixed widths", () => {
    const built = buildId3v1({ ...BLANK, title: "T".repeat(50), genre: "Jazz" });
    expect(built).toHaveLength(128);
    const parsed = parseId3v1(concat([audio(), built]));
    expect(parsed?.title).toBe("T".repeat(30));
    expect(parsed?.genreIndex).toBe(8);
  });

  it("writes genre 255 for a name that is not one of the 192", () => {
    const built = buildId3v1({ ...BLANK, genre: "Sea Shanty Revival" });
    expect(built[127]).toBe(255);
  });
});

/* ------------------------------------------------------------------ */
/* FLAC                                                                */
/* ------------------------------------------------------------------ */

describe("FLAC Vorbis comments", () => {
  function le32(value: number): Uint8Array {
    return new Uint8Array([
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    ]);
  }

  function block(type: number, body: Uint8Array, last: boolean): Uint8Array {
    return concat([
      new Uint8Array([
        (last ? 0x80 : 0) | type,
        (body.length >> 16) & 0xff,
        (body.length >> 8) & 0xff,
        body.length & 0xff,
      ]),
      body,
    ]);
  }

  function comments(pairs: string[]): Uint8Array {
    const vendor = new TextEncoder().encode("tools.maxhogan.dev");
    const encoded = pairs.map((pair) => {
      const bytes = new TextEncoder().encode(pair);
      return concat([le32(bytes.length), bytes]);
    });
    return concat([le32(vendor.length), vendor, le32(pairs.length), ...encoded]);
  }

  it("reads the standard fields", () => {
    const file = concat([
      latin1("fLaC"),
      block(
        4,
        comments(["TITLE=Lossless", "ARTIST=Studio Cat", "ALBUM=Uncompressed", "DATE=2021"]),
        true,
      ),
      new Uint8Array(64),
    ]);
    const info = parseId3(file);
    expect(info.container).toBe("flac");
    expect(info.version).toBe("Vorbis comment");
    expect(info.tag.title).toBe("Lossless");
    expect(info.tag.artist).toBe("Studio Cat");
    expect(info.tag.year).toBe("2021");
    expect(info.frames).toHaveLength(4);
  });

  it("reads a PICTURE block as cover art", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 5, 5]);
    const mime = latin1("image/png");
    const description = latin1("Art");
    const picture = concat([
      plainSize(3),
      plainSize(mime.length),
      mime,
      plainSize(description.length),
      description,
      new Uint8Array(16), // width, height, depth, colors
      plainSize(png.length),
      png,
    ]);
    const file = concat([
      latin1("fLaC"),
      block(4, comments(["TITLE=With art"]), false),
      block(6, picture, true),
      new Uint8Array(32),
    ]);
    const info = parseId3(file);
    expect(info.cover?.mime).toBe("image/png");
    expect(info.cover?.description).toBe("Art");
    expect(Array.from(info.cover?.bytes ?? [])).toEqual(Array.from(png));
    expect(info.audioOffset).toBe(file.length - 32);
  });
});

/* ------------------------------------------------------------------ */
/* the shipped sample                                                  */
/* ------------------------------------------------------------------ */

describe("public/samples/sample.mp3", () => {
  it("parses the file the example button loads", () => {
    const bytes = new Uint8Array(readFileSync("public/samples/sample.mp3"));
    const info = parseId3(bytes);
    expect(info.version).toBe("ID3v2.3.0");
    expect(info.tag.title).toBe("Sample Tone");
    expect(info.tag.artist).toBe("Tools Demo");
    expect(info.tag.genre).toBe("Electronic");
    expect(info.cover?.mime).toBe("image/png");
    expect(info.cover?.bytes.length).toBeGreaterThan(60);
    expect(info.v1?.version).toBe("1.1");
    expect(info.stream?.bitrate).toBe(128);
    expect(info.warnings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

describe("run", () => {
  const file = concat([
    tag(3, concat([frame("TIT2", textBody("Runner")), frame("TPE1", textBody("Band"))]), 0, 32),
    audio(),
  ]);

  it("reports the tag and the file layout by default", () => {
    const out = run(file, { view: "tags" });
    expect(out.Title).toBe("Runner");
    expect(out.Artist).toBe("Band");
    expect(out["Tag version"]).toBe("ID3v2.3.0");
    expect(out["Audio format"]).toBe("MPEG-1 Layer III");
    expect(out.Frames).toBe("2");
  });

  it("lists frames on the frames view", () => {
    const out = run(file, { view: "frames" });
    expect(Object.keys(out)[0]).toBe("01. TIT2 (Title)");
    expect(out["02. TPE1 (Artist)"]).toContain("Band");
  });

  it("merges both on the all view", () => {
    const out = run(file, { view: "all" });
    expect(out.Title).toBe("Runner");
    expect(out["01. TIT2 (Title)"]).toContain("Runner");
  });

  it("rejects an empty input", () => {
    expect(() => run(new Uint8Array(0), { view: "tags" })).toThrowError(ToolError);
    try {
      run("   ", { view: "tags" });
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("rejects a file that is neither MP3 nor FLAC", () => {
    try {
      run(new Uint8Array(4096), { view: "tags" });
      expect.unreachable("a file with no frame sync should not parse");
    } catch (e) {
      expect((e as ToolError).code).toBe("not-audio");
      expect((e as ToolError).fix).toContain(".mp3");
    }
  });

  it("rejects a tag version that does not exist", () => {
    const file = concat([latin1("ID3"), new Uint8Array([5, 0, 0]), syncsafe(0), audio()]);
    try {
      run(file, { view: "tags" });
      expect.unreachable("ID3v2.5 should be refused");
    } catch (e) {
      expect((e as ToolError).code).toBe("unsupported-tag");
    }
  });
});
