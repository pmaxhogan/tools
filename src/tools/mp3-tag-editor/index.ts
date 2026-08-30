import { formatBytes } from "@/lib/format";
import { ToolError, type ToolLogic } from "../types";

/**
 * ID3 tag reader and writer.
 *
 * Everything here is hand rolled bytes: there is no ID3 dependency, and there
 * does not need to be one. The format is a header, a run of frames, and some
 * padding, and the only genuinely awkward parts are the ones a library would
 * hide badly anyway: four text encodings, two incompatible frame size
 * encodings, and the unsynchronization scheme.
 *
 * The module stays pure (rule 27) so the panel can hand it bytes and get a
 * plain object back, and so every branch below is testable in Node. Reading
 * covers ID3v2.2, v2.3 and v2.4 plus the 128 byte ID3v1 trailer, and FLAC
 * Vorbis comments read only. Writing always emits ID3v2.3, which is the
 * version every player in circulation actually agrees on.
 */

/* ------------------------------------------------------------------ */
/* limits and tables                                                   */
/* ------------------------------------------------------------------ */

/** Refuse anything past this: the whole file is held in memory. */
const MAX_BYTES = 300 * 1024 * 1024;

/** Padding written after the frames so a later edit can grow in place. */
const DEFAULT_PADDING = 1024;

/** Bytes of cover art accepted into a rebuilt tag. */
const MAX_COVER_BYTES = 16 * 1024 * 1024;

/** The ID3v1 genre byte, including the Winamp extensions everyone ships. */
const GENRES = [
  "Blues",
  "Classic Rock",
  "Country",
  "Dance",
  "Disco",
  "Funk",
  "Grunge",
  "Hip-Hop",
  "Jazz",
  "Metal",
  "New Age",
  "Oldies",
  "Other",
  "Pop",
  "R&B",
  "Rap",
  "Reggae",
  "Rock",
  "Techno",
  "Industrial",
  "Alternative",
  "Ska",
  "Death Metal",
  "Pranks",
  "Soundtrack",
  "Euro-Techno",
  "Ambient",
  "Trip-Hop",
  "Vocal",
  "Jazz+Funk",
  "Fusion",
  "Trance",
  "Classical",
  "Instrumental",
  "Acid",
  "House",
  "Game",
  "Sound Clip",
  "Gospel",
  "Noise",
  "Alt. Rock",
  "Bass",
  "Soul",
  "Punk",
  "Space",
  "Meditative",
  "Instrumental Pop",
  "Instrumental Rock",
  "Ethnic",
  "Gothic",
  "Darkwave",
  "Techno-Industrial",
  "Electronic",
  "Pop-Folk",
  "Eurodance",
  "Dream",
  "Southern Rock",
  "Comedy",
  "Cult",
  "Gangsta Rap",
  "Top 40",
  "Christian Rap",
  "Pop/Funk",
  "Jungle",
  "Native American",
  "Cabaret",
  "New Wave",
  "Psychedelic",
  "Rave",
  "Showtunes",
  "Trailer",
  "Lo-Fi",
  "Tribal",
  "Acid Punk",
  "Acid Jazz",
  "Polka",
  "Retro",
  "Musical",
  "Rock & Roll",
  "Hard Rock",
  "Folk",
  "Folk/Rock",
  "National Folk",
  "Swing",
  "Fast-Fusion",
  "Bebop",
  "Latin",
  "Revival",
  "Celtic",
  "Bluegrass",
  "Avantgarde",
  "Gothic Rock",
  "Progressive Rock",
  "Psychedelic Rock",
  "Symphonic Rock",
  "Slow Rock",
  "Big Band",
  "Chorus",
  "Easy Listening",
  "Acoustic",
  "Humour", // spelling: allow (genre 103 is spelled this way in the ID3v1 list)
  "Speech",
  "Chanson",
  "Opera",
  "Chamber Music",
  "Sonata",
  "Symphony",
  "Booty Bass",
  "Primus",
  "Porn Groove",
  "Satire",
  "Slow Jam",
  "Club",
  "Tango",
  "Samba",
  "Folklore",
  "Ballad",
  "Power Ballad",
  "Rhythmic Soul",
  "Freestyle",
  "Duet",
  "Punk Rock",
  "Drum Solo",
  "A Cappella",
  "Euro-House",
  "Dance Hall",
  "Goa",
  "Drum & Bass",
  "Club-House",
  "Hardcore",
  "Terror",
  "Indie",
  "BritPop",
  "Negerpunk",
  "Polsk Punk",
  "Beat",
  "Christian Gangsta Rap",
  "Heavy Metal",
  "Black Metal",
  "Crossover",
  "Contemporary Christian",
  "Christian Rock",
  "Merengue",
  "Salsa",
  "Thrash Metal",
  "Anime",
  "JPop",
  "Synthpop",
] as const;

/** APIC picture type byte to the label the spec gives it. */
const PICTURE_TYPES = [
  "Other",
  "32x32 file icon",
  "Other file icon",
  "Front cover",
  "Back cover",
  "Leaflet page",
  "Media",
  "Lead artist",
  "Artist",
  "Conductor",
  "Band",
  "Composer",
  "Lyricist",
  "Recording location",
  "During recording",
  "During performance",
  "Screen capture",
  "A bright colored fish",
  "Illustration",
  "Band logotype",
  "Publisher logotype",
] as const;

/** Human names for the frame ids worth naming. Anything else shows its id. */
const FRAME_LABELS: Record<string, string> = {
  TIT2: "Title",
  TIT1: "Content group",
  TIT3: "Subtitle",
  TPE1: "Artist",
  TPE2: "Album artist",
  TPE3: "Conductor",
  TPE4: "Remixer",
  TALB: "Album",
  TYER: "Year",
  TDRC: "Recording date",
  TDRL: "Release date",
  TDAT: "Date",
  TIME: "Time",
  TRCK: "Track number",
  TPOS: "Disc number",
  TCON: "Genre",
  TCOM: "Composer",
  TEXT: "Lyricist",
  TBPM: "Beats per minute",
  TKEY: "Initial key",
  TLAN: "Language",
  TLEN: "Length",
  TPUB: "Publisher",
  TCOP: "Copyright",
  TENC: "Encoded by",
  TSSE: "Encoder settings",
  TSRC: "ISRC",
  TCMP: "Part of a compilation",
  TSOT: "Title sort order",
  TSOP: "Artist sort order",
  TSOA: "Album sort order",
  COMM: "Comment",
  USLT: "Lyrics",
  APIC: "Cover art",
  TXXX: "User text",
  WXXX: "User URL",
  WOAR: "Artist URL",
  WOAF: "File URL",
  WCOM: "Commercial URL",
  WPUB: "Publisher URL",
  MCDI: "Music CD identifier",
  PRIV: "Private data",
  UFID: "Unique file identifier",
  POPM: "Popularimeter",
  RGAD: "Replay gain",
};

/** ID3v2.2's three character ids, mapped onto the v2.3 id with the same job. */
const V22_TO_V23: Record<string, string> = {
  TT1: "TIT1",
  TT2: "TIT2",
  TT3: "TIT3",
  TP1: "TPE1",
  TP2: "TPE2",
  TP3: "TPE3",
  TP4: "TPE4",
  TAL: "TALB",
  TYE: "TYER",
  TDA: "TDAT",
  TIM: "TIME",
  TRK: "TRCK",
  TPA: "TPOS",
  TCO: "TCON",
  TCM: "TCOM",
  TXT: "TEXT",
  TBP: "TBPM",
  TKE: "TKEY",
  TLA: "TLAN",
  TLE: "TLEN",
  TPB: "TPUB",
  TCR: "TCOP",
  TEN: "TENC",
  TSS: "TSSE",
  TRC: "TSRC",
  COM: "COMM",
  ULT: "USLT",
  PIC: "APIC",
  TXX: "TXXX",
  WXX: "WXXX",
};

/** Bitrate tables in kbps, indexed by the four bit bitrate field. */
const BITRATES: Record<string, number[]> = {
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};

const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

const CHANNEL_MODES = ["Stereo", "Joint stereo", "Dual channel", "Mono"] as const;

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

/** One frame as found in the tag, decoded far enough to be listed. */
export interface Id3Frame {
  /** Frame id normalized to its four character v2.3/v2.4 form. */
  id: string;
  /** The id exactly as stored, which differs from `id` only in ID3v2.2. */
  rawId: string;
  /** Label for the id, or the id itself when it has no friendly name. */
  label: string;
  /** Body size in bytes as the tag declares it. */
  size: number;
  /** Decoded text, for the frames that hold text or a URL. */
  value?: string;
  /** Description field of COMM, USLT, TXXX, WXXX and APIC. */
  description?: string;
  /** Three letter language code of COMM and USLT. */
  language?: string;
  compressed: boolean;
  encrypted: boolean;
  /** True when this single frame carried the v2.4 unsynchronization flag. */
  unsynchronized: boolean;
}

/** An attached picture, ready for a blob URL or for writing back out. */
export interface Id3Picture {
  mime: string;
  /** APIC picture type byte. 3 is the front cover. */
  pictureType: number;
  typeLabel: string;
  description: string;
  bytes: Uint8Array;
}

/** The 128 byte trailer, when the file still carries one. */
export interface Id3v1Tag {
  version: "1.0" | "1.1";
  title: string;
  artist: string;
  album: string;
  year: string;
  comment: string;
  track?: number;
  genre?: string;
  genreIndex: number;
  /** The optional 227 byte "TAG+" block that precedes an ID3v1 tag. */
  extended?: { title: string; artist: string; album: string; genre: string };
}

/** The editable fields, which is what the panel's form binds to. */
export interface EditableTag {
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  year: string;
  track: string;
  disc: string;
  genre: string;
  composer: string;
  comment: string;
}

/** What the first MPEG audio frame says about the stream. */
export interface Mp3StreamInfo {
  /** "MPEG-1 Layer III" and friends. */
  codec: string;
  bitrate: number;
  sampleRate: number;
  channelMode: string;
  channels: number;
  /** True when a Xing or VBRI header declares the stream variable rate. */
  vbr: boolean;
  /** Seconds, from the VBR frame count when there is one, else from the size. */
  durationSeconds: number;
  /** Byte offset of the first valid frame header. */
  frameOffset: number;
}

export interface Id3Flags {
  unsynchronized: boolean;
  extendedHeader: boolean;
  experimental: boolean;
  footer: boolean;
}

/** Everything `parseId3` learned about a file. */
export interface Id3Info {
  container: "mp3" | "flac";
  /** "ID3v2.3.0", "ID3v1.1", "Vorbis comment", or "none". */
  version: string;
  major: number;
  revision: number;
  /** Bytes the ID3v2 tag occupies, header and footer included. 0 when absent. */
  tagSize: number;
  flags: Id3Flags;
  frames: Id3Frame[];
  tag: EditableTag;
  cover?: Id3Picture;
  /** First byte of audio data. */
  audioOffset: number;
  /** Bytes of audio, trailing ID3v1 and TAG+ blocks excluded. */
  audioSize: number;
  fileSize: number;
  v1?: Id3v1Tag;
  stream?: Mp3StreamInfo;
  /** Anything survivable that the file got wrong, in reading order. */
  warnings: string[];
}

export interface BuildOptions {
  /** Cover art to write, or null for a tag with no picture. */
  cover?: Id3Picture | null;
  /** Zero bytes written after the frames. Default 1024. */
  padding?: number;
  /** Append a rebuilt 128 byte ID3v1 trailer as well. Default false. */
  writeId3v1?: boolean;
}

export interface Mp3TagOpts {
  /** tags | frames | all */
  view: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* byte helpers                                                        */
/* ------------------------------------------------------------------ */

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

/** ID3's seven-bits-per-byte integer, used for every v2.4 size. */
function readSyncsafe(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) & 0x7f) * 0x200000 +
    ((bytes[offset + 1] ?? 0) & 0x7f) * 0x4000 +
    ((bytes[offset + 2] ?? 0) & 0x7f) * 0x80 +
    ((bytes[offset + 3] ?? 0) & 0x7f)
  );
}

function writeSyncsafe(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 21) & 0x7f;
  target[offset + 1] = (value >>> 14) & 0x7f;
  target[offset + 2] = (value >>> 7) & 0x7f;
  target[offset + 3] = value & 0x7f;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) * 0x1000000 +
    (bytes[offset + 1] ?? 0) * 0x10000 +
    (bytes[offset + 2] ?? 0) * 0x100 +
    (bytes[offset + 3] ?? 0)
  );
}

/**
 * Undo the unsynchronization scheme: a 0x00 inserted after every 0xFF so that
 * no byte pair inside the tag can be mistaken for an MPEG frame sync by a
 * decoder that does not understand ID3 at all.
 */
function deunsynchronize(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let written = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0;
    out[written++] = byte;
    if (byte === 0xff && bytes[i + 1] === 0x00) i++;
  }
  return out.subarray(0, written);
}

/* ------------------------------------------------------------------ */
/* text decoding                                                       */
/* ------------------------------------------------------------------ */

const UTF8 = new TextDecoder("utf-8");
const UTF16LE = new TextDecoder("utf-16le");
const UTF16BE = new TextDecoder("utf-16be");

function decodeLatin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}

/**
 * Decode one text run in the encoding its frame declared.
 *
 * Encoding 1 is UTF-16 with a byte order mark, which is the only place the
 * mark decides endianness; a missing or broken mark falls back to little
 * endian, which is what every writer that gets this wrong actually emits.
 */
function decodeText(bytes: Uint8Array, encoding: number): string {
  if (bytes.length === 0) return "";
  switch (encoding) {
    case 1: {
      if (bytes[0] === 0xff && bytes[1] === 0xfe) return UTF16LE.decode(bytes.subarray(2));
      if (bytes[0] === 0xfe && bytes[1] === 0xff) return UTF16BE.decode(bytes.subarray(2));
      return UTF16LE.decode(bytes);
    }
    case 2:
      return UTF16BE.decode(bytes);
    case 3:
      return UTF8.decode(bytes);
    default:
      return decodeLatin1(bytes);
  }
}

/** Trim the trailing NULs a writer padded a fixed width field with. */
function trimNuls(text: string): string {
  return text.replace(/\0+$/, "").trim();
}

/**
 * Split a frame body at the terminator that separates a description from the
 * value. Two byte encodings terminate on an aligned 00 00 pair, which is why
 * this cannot be a single indexOf.
 */
function splitAtTerminator(
  bytes: Uint8Array,
  start: number,
  encoding: number,
): { text: string; next: number } {
  const wide = encoding === 1 || encoding === 2;
  if (wide) {
    for (let i = start; i + 1 < bytes.length; i += 2) {
      if (bytes[i] === 0x00 && bytes[i + 1] === 0x00) {
        return { text: decodeText(bytes.subarray(start, i), encoding), next: i + 2 };
      }
    }
    return { text: decodeText(bytes.subarray(start), encoding), next: bytes.length };
  }
  for (let i = start; i < bytes.length; i++) {
    if (bytes[i] === 0x00) {
      return { text: decodeText(bytes.subarray(start, i), encoding), next: i + 1 };
    }
  }
  return { text: decodeText(bytes.subarray(start), encoding), next: bytes.length };
}

/**
 * A text frame's payload. ID3v2.4 allows several values separated by NUL, and
 * v2.3 writers occasionally do it anyway, so both are joined the same way.
 */
function decodeTextFrame(body: Uint8Array): string {
  if (body.length === 0) return "";
  const encoding = body[0] ?? 0;
  const parts: string[] = [];
  let at = 1;
  while (at < body.length) {
    const { text, next } = splitAtTerminator(body, at, encoding);
    if (text.length > 0) parts.push(text);
    if (next <= at) break;
    at = next;
  }
  return parts.join(" / ").replace(/\0/g, "").trim();
}

/* ------------------------------------------------------------------ */
/* genre                                                               */
/* ------------------------------------------------------------------ */

/**
 * Resolve a TCON value. It may be plain text, a bare number, a "(17)" style
 * reference, "(17)Rock" with a refinement after it, or several of those in a
 * row; every form has been shipped by some tagger.
 */
export function resolveGenre(raw: string): string {
  const text = raw.trim();
  if (text.length === 0) return "";

  const parts: string[] = [];
  const pattern = /\((\d+|RX|CR)\)|([^()]+)/g;
  let match = pattern.exec(text);
  let sawReference = false;

  while (match) {
    if (match[1] !== undefined) {
      sawReference = true;
      if (match[1] === "RX") parts.push("Remix");
      else if (match[1] === "CR") parts.push("Cover");
      else parts.push(GENRES[Number(match[1])] ?? `Genre ${match[1]}`);
    } else if (match[2] !== undefined) {
      const chunk = match[2].trim();
      if (chunk.length > 0) parts.push(chunk);
    }
    match = pattern.exec(text);
  }

  if (!sawReference && /^\d+$/.test(text)) return GENRES[Number(text)] ?? text;
  const unique = parts.filter((part, index) => parts.indexOf(part) === index);
  return unique.join(" / ");
}

/** The ID3v1 genre byte for a name, or 255 when it is not one of the 192. */
function genreIndexFor(name: string): number {
  const wanted = name.trim().toLowerCase();
  const found = GENRES.findIndex((genre) => genre.toLowerCase() === wanted);
  return found >= 0 ? found : 255;
}

/* ------------------------------------------------------------------ */
/* input handling                                                      */
/* ------------------------------------------------------------------ */

function toBytes(input: Uint8Array | string): Uint8Array {
  if (typeof input === "string") {
    if (input.trim().length === 0) {
      throw new ToolError(
        "empty-input",
        "No audio file was given.",
        "Drop an .mp3 or .flac file onto the input, or pick one with the file button.",
      );
    }
    return new TextEncoder().encode(input);
  }
  if (input.length === 0) {
    throw new ToolError(
      "empty-input",
      "The file is empty: it holds zero bytes.",
      "Check the file saved correctly, then drop it again.",
    );
  }
  return input;
}

function emptyTag(): EditableTag {
  return {
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
}

/* ------------------------------------------------------------------ */
/* ID3v1                                                               */
/* ------------------------------------------------------------------ */

/** Read the 128 byte trailer, plus the 227 byte "TAG+" block before it. */
export function parseId3v1(bytes: Uint8Array): Id3v1Tag | undefined {
  if (bytes.length < 128) return undefined;
  const start = bytes.length - 128;
  if (ascii(bytes, start, 3) !== "TAG") return undefined;

  const field = (offset: number, length: number) =>
    trimNuls(decodeLatin1(bytes.subarray(start + offset, start + offset + length)));

  const commentBytes = bytes.subarray(start + 97, start + 127);
  const oneOne = commentBytes[28] === 0x00 && (commentBytes[29] ?? 0) !== 0x00;
  const genreIndex = bytes[start + 127] ?? 255;

  const tag: Id3v1Tag = {
    version: oneOne ? "1.1" : "1.0",
    title: field(3, 30),
    artist: field(33, 30),
    album: field(63, 30),
    year: field(93, 4),
    comment: trimNuls(decodeLatin1(commentBytes.subarray(0, oneOne ? 28 : 30))),
    track: oneOne ? commentBytes[29] : undefined,
    genre: GENRES[genreIndex],
    genreIndex,
  };

  const extStart = start - 227;
  if (extStart >= 0 && ascii(bytes, extStart, 4) === "TAG+") {
    const ext = (offset: number, length: number) =>
      trimNuls(decodeLatin1(bytes.subarray(extStart + offset, extStart + offset + length)));
    tag.extended = {
      title: ext(4, 60),
      artist: ext(64, 60),
      album: ext(124, 60),
      genre: ext(185, 30),
    };
  }

  return tag;
}

/** Bytes of trailing metadata at the end of the file: ID3v1 and its TAG+. */
function trailerSize(bytes: Uint8Array, v1: Id3v1Tag | undefined): number {
  if (!v1) return 0;
  return 128 + (v1.extended ? 227 : 0);
}

/* ------------------------------------------------------------------ */
/* MPEG stream                                                         */
/* ------------------------------------------------------------------ */

interface FrameHeader {
  versionBits: number;
  layer: number;
  bitrate: number;
  sampleRate: number;
  channelMode: number;
  padding: number;
  frameLength: number;
  samplesPerFrame: number;
}

function readFrameHeader(bytes: Uint8Array, at: number): FrameHeader | null {
  if (at + 4 > bytes.length) return null;
  const b0 = bytes[at] ?? 0;
  const b1 = bytes[at + 1] ?? 0;
  const b2 = bytes[at + 2] ?? 0;
  const b3 = bytes[at + 3] ?? 0;
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  if (versionBits === 1 || layerBits === 0) return null;

  const layer = 4 - layerBits;
  const generation = versionBits === 3 ? 1 : 2;
  const bitrateRow = BITRATES[`${generation}-${layer}`];
  const bitrate = bitrateRow?.[(b2 >> 4) & 0x0f] ?? 0;
  const sampleRate = SAMPLE_RATES[versionBits]?.[(b2 >> 2) & 0x03] ?? 0;
  if (bitrate === 0 || sampleRate === 0) return null;

  const padding = (b2 >> 1) & 0x01;
  const samplesPerFrame = layer === 1 ? 384 : layer === 2 || versionBits === 3 ? 1152 : 576;
  const frameLength =
    layer === 1
      ? (Math.floor((12 * bitrate * 1000) / sampleRate) + padding) * 4
      : Math.floor((samplesPerFrame / 8) * ((bitrate * 1000) / sampleRate)) + padding;

  return {
    versionBits,
    layer,
    bitrate,
    sampleRate,
    channelMode: (b3 >> 6) & 0x03,
    padding,
    frameLength,
    samplesPerFrame,
  };
}

/**
 * A Xing or Info header (CBR files write "Info", VBR files write "Xing") sits
 * inside the first frame at an offset that depends on the version and channel
 * mode. VBRI is Fraunhofer's equivalent and always sits 32 bytes in.
 */
function readVbrHeader(
  bytes: Uint8Array,
  frameStart: number,
  header: FrameHeader,
): { frames: number; vbr: boolean } | null {
  const mono = header.channelMode === 3;
  const sideInfo = header.versionBits === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
  const xingAt = frameStart + 4 + sideInfo;
  const tag = ascii(bytes, xingAt, 4);
  if (tag === "Xing" || tag === "Info") {
    const flags = readUint32BE(bytes, xingAt + 4);
    if ((flags & 0x01) === 0) return null;
    return { frames: readUint32BE(bytes, xingAt + 8), vbr: tag === "Xing" };
  }
  if (ascii(bytes, frameStart + 4 + 32, 4) === "VBRI") {
    const at = frameStart + 4 + 32;
    return { frames: readUint32BE(bytes, at + 14), vbr: true };
  }
  return null;
}

/**
 * Describe the stream from its first valid frame header. The scan is bounded:
 * a file whose audio does not start where the tag says it does is a broken
 * file, not a reason to walk megabytes of it.
 */
export function readStreamInfo(
  bytes: Uint8Array,
  audioOffset: number,
  audioSize: number,
): Mp3StreamInfo | undefined {
  const limit = Math.min(bytes.length - 4, audioOffset + 64 * 1024);
  for (let at = audioOffset; at <= limit; at++) {
    const header = readFrameHeader(bytes, at);
    if (!header) continue;
    // One valid header can appear by chance inside data; a second header
    // exactly one frame later is what makes it a real stream.
    const next = readFrameHeader(bytes, at + header.frameLength);
    if (!next && at + header.frameLength < bytes.length - 4) continue;

    const vbrInfo = readVbrHeader(bytes, at, header);
    const remaining = audioSize - (at - audioOffset);
    const durationSeconds = vbrInfo
      ? (vbrInfo.frames * header.samplesPerFrame) / header.sampleRate
      : remaining / ((header.bitrate * 1000) / 8);

    const generation =
      header.versionBits === 3 ? "MPEG-1" : header.versionBits === 2 ? "MPEG-2" : "MPEG-2.5";
    return {
      codec: `${generation} Layer ${"I".repeat(header.layer)}`,
      bitrate: header.bitrate,
      sampleRate: header.sampleRate,
      channelMode: CHANNEL_MODES[header.channelMode] ?? "Stereo",
      channels: header.channelMode === 3 ? 1 : 2,
      vbr: vbrInfo?.vbr ?? false,
      durationSeconds: Math.max(0, durationSeconds),
      frameOffset: at,
    };
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* FLAC                                                                */
/* ------------------------------------------------------------------ */

function isFlac(bytes: Uint8Array): boolean {
  return ascii(bytes, 0, 4) === "fLaC";
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) +
    (bytes[offset + 1] ?? 0) * 0x100 +
    (bytes[offset + 2] ?? 0) * 0x10000 +
    (bytes[offset + 3] ?? 0) * 0x1000000
  );
}

/**
 * FLAC metadata blocks, read only. Vorbis comments are KEY=value strings with
 * little endian lengths, which is the one place FLAC disagrees with every
 * other container in this file. Block type 6 carries a picture laid out almost
 * like APIC, but big endian and with explicit lengths instead of terminators.
 */
function parseFlac(bytes: Uint8Array): Id3Info {
  const info: Id3Info = {
    container: "flac",
    version: "Vorbis comment",
    major: 0,
    revision: 0,
    tagSize: 0,
    flags: { unsynchronized: false, extendedHeader: false, experimental: false, footer: false },
    frames: [],
    tag: emptyTag(),
    audioOffset: 4,
    audioSize: Math.max(0, bytes.length - 4),
    fileSize: bytes.length,
    warnings: [],
  };

  let at = 4;
  let last = false;
  while (!last && at + 4 <= bytes.length) {
    const header = bytes[at] ?? 0;
    last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length =
      ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0);
    const body = bytes.subarray(at + 4, at + 4 + length);
    if (body.length < length) {
      info.warnings.push("A FLAC metadata block runs past the end of the file.");
      break;
    }

    if (type === 4) readVorbisComments(body, info);
    else if (type === 6) readFlacPicture(body, info);

    at += 4 + length;
  }

  info.audioOffset = at;
  info.audioSize = Math.max(0, bytes.length - at);
  return info;
}

function readVorbisComments(body: Uint8Array, info: Id3Info): void {
  let at = 0;
  const vendorLength = readUint32LE(body, at);
  at += 4 + vendorLength;
  if (at + 4 > body.length) return;
  const count = readUint32LE(body, at);
  at += 4;

  for (let i = 0; i < count && at + 4 <= body.length; i++) {
    const length = readUint32LE(body, at);
    at += 4;
    const text = UTF8.decode(body.subarray(at, at + length));
    at += length;

    const split = text.indexOf("=");
    if (split < 0) continue;
    const key = text.slice(0, split).toUpperCase();
    const value = text.slice(split + 1);

    info.frames.push({
      id: key,
      rawId: key,
      label: key,
      size: length,
      value,
      compressed: false,
      encrypted: false,
      unsynchronized: false,
    });

    switch (key) {
      case "TITLE":
        info.tag.title ||= value;
        break;
      case "ARTIST":
        info.tag.artist ||= value;
        break;
      case "ALBUMARTIST":
        info.tag.albumArtist ||= value;
        break;
      case "ALBUM":
        info.tag.album ||= value;
        break;
      case "DATE":
      case "YEAR":
        info.tag.year ||= value;
        break;
      case "TRACKNUMBER":
        info.tag.track ||= value;
        break;
      case "DISCNUMBER":
        info.tag.disc ||= value;
        break;
      case "GENRE":
        info.tag.genre ||= value;
        break;
      case "COMPOSER":
        info.tag.composer ||= value;
        break;
      case "COMMENT":
      case "DESCRIPTION":
        info.tag.comment ||= value;
        break;
      default:
        break;
    }
  }
}

function readFlacPicture(body: Uint8Array, info: Id3Info): void {
  let at = 0;
  const pictureType = readUint32BE(body, at);
  at += 4;
  const mimeLength = readUint32BE(body, at);
  at += 4;
  const mime = decodeLatin1(body.subarray(at, at + mimeLength));
  at += mimeLength;
  const descLength = readUint32BE(body, at);
  at += 4;
  const description = UTF8.decode(body.subarray(at, at + descLength));
  at += descLength + 16;
  const dataLength = readUint32BE(body, at);
  at += 4;

  const picture: Id3Picture = {
    mime,
    pictureType,
    typeLabel: PICTURE_TYPES[pictureType] ?? `Type ${pictureType}`,
    description,
    bytes: body.slice(at, at + dataLength),
  };
  info.frames.push({
    id: "PICTURE",
    rawId: "PICTURE",
    label: "Cover art",
    size: body.length,
    description,
    value: `${mime}, ${picture.bytes.length} bytes`,
    compressed: false,
    encrypted: false,
    unsynchronized: false,
  });
  if (!info.cover || pictureType === 3) info.cover = picture;
}

/* ------------------------------------------------------------------ */
/* ID3v2 parsing                                                       */
/* ------------------------------------------------------------------ */

/** Where the frames start inside the tag body, once an extended header is skipped. */
function skipExtendedHeader(body: Uint8Array, major: number, warnings: string[]): number {
  if (body.length < 6) return 0;
  if (major >= 4) {
    const size = readSyncsafe(body, 0);
    if (size < 6 || size > body.length) {
      warnings.push("The extended header declares a size the tag cannot hold; it was skipped.");
      return 0;
    }
    return size;
  }
  // v2.3 stores a plain size that excludes its own four bytes.
  const size = readUint32BE(body, 0);
  if (size + 4 > body.length) {
    warnings.push("The extended header declares a size the tag cannot hold; it was skipped.");
    return 0;
  }
  return size + 4;
}

function frameLabel(id: string): string {
  return FRAME_LABELS[id] ?? id;
}

function parseFrames(body: Uint8Array, major: number, headerUnsync: boolean, info: Id3Info): void {
  const idLength = major === 2 ? 3 : 4;
  const headerLength = major === 2 ? 6 : 10;
  let at = 0;

  while (at + headerLength <= body.length) {
    const rawId = ascii(body, at, idLength);
    // Padding is a run of zero bytes; the first one ends the frame list.
    if (rawId.charCodeAt(0) === 0) break;
    if (!/^[A-Z0-9]+$/.test(rawId)) {
      info.warnings.push(`Stopped at an unreadable frame id after ${at} bytes of frames.`);
      break;
    }

    let size: number;
    let flags = 0;
    if (major === 2) {
      size = ((body[at + 3] ?? 0) << 16) | ((body[at + 4] ?? 0) << 8) | (body[at + 5] ?? 0);
    } else if (major >= 4) {
      size = readSyncsafe(body, at + 4);
      flags = ((body[at + 8] ?? 0) << 8) | (body[at + 9] ?? 0);
      // Some v2.4 writers store a plain size anyway. When the syncsafe read
      // does not land on the next frame and the plain read does, trust the
      // plain one: guessing right here is the difference between reading the
      // whole tag and reading one frame.
      const plain = readUint32BE(body, at + 4);
      if (
        plain !== size &&
        looksLikeFrameAt(body, at + headerLength + plain, idLength, headerLength)
      ) {
        if (!looksLikeFrameAt(body, at + headerLength + size, idLength, headerLength)) size = plain;
      }
    } else {
      size = readUint32BE(body, at + 4);
      flags = ((body[at + 8] ?? 0) << 8) | (body[at + 9] ?? 0);
    }

    if (size < 0 || at + headerLength + size > body.length) {
      info.warnings.push(`Frame ${rawId} declares ${size} bytes, more than the tag holds.`);
      break;
    }

    const compressed =
      major === 2 ? false : major >= 4 ? (flags & 0x0008) !== 0 : (flags & 0x0080) !== 0;
    const encrypted =
      major === 2 ? false : major >= 4 ? (flags & 0x0004) !== 0 : (flags & 0x0040) !== 0;
    const grouped = major >= 4 ? (flags & 0x0040) !== 0 : (flags & 0x0020) !== 0;
    const frameUnsync = major >= 4 && (flags & 0x0002) !== 0;
    const hasDataLength = major >= 4 && (flags & 0x0001) !== 0;

    let content = body.subarray(at + headerLength, at + headerLength + size);
    if (grouped) content = content.subarray(1);
    if (hasDataLength) content = content.subarray(4);
    if (major >= 4 && frameUnsync && !headerUnsync) content = deunsynchronize(content);

    const id = major === 2 ? (V22_TO_V23[rawId] ?? rawId) : rawId;
    const frame: Id3Frame = {
      id,
      rawId,
      label: frameLabel(id),
      size,
      compressed,
      encrypted,
      unsynchronized: frameUnsync,
    };

    if (compressed || encrypted) {
      info.warnings.push(
        `Frame ${rawId} is ${compressed ? "compressed" : "encrypted"}, so its value was not read.`,
      );
    } else {
      readFrameBody(frame, content, id, major, info);
    }

    info.frames.push(frame);
    at += headerLength + size;
  }
}

/** Does a frame header plausibly start here? Used to disambiguate v2.4 sizes. */
function looksLikeFrameAt(
  body: Uint8Array,
  at: number,
  idLength: number,
  headerLength: number,
): boolean {
  if (at === body.length) return true;
  if (at + headerLength > body.length) return false;
  return /^[A-Z0-9]+$/.test(ascii(body, at, idLength));
}

function readFrameBody(
  frame: Id3Frame,
  content: Uint8Array,
  id: string,
  major: number,
  info: Id3Info,
): void {
  if (id === "APIC") {
    const picture = readApic(content, major);
    if (picture) {
      frame.description = picture.description;
      frame.value = `${picture.typeLabel}, ${picture.mime}, ${picture.bytes.length} bytes`;
      if (!info.cover || picture.pictureType === 3) info.cover = picture;
    }
    return;
  }

  if (id === "COMM" || id === "USLT") {
    const encoding = content[0] ?? 0;
    frame.language = ascii(content, 1, 3);
    const { text: description, next } = splitAtTerminator(content, 4, encoding);
    frame.description = description;
    frame.value = decodeText(content.subarray(next), encoding).replace(/\0/g, "");
    return;
  }

  if (id === "TXXX" || id === "WXXX") {
    const encoding = content[0] ?? 0;
    const { text: description, next } = splitAtTerminator(content, 1, encoding);
    frame.description = description;
    frame.value =
      id === "WXXX"
        ? trimNuls(decodeLatin1(content.subarray(next)))
        : decodeText(content.subarray(next), encoding).replace(/\0/g, "");
    return;
  }

  if (id.startsWith("W")) {
    frame.value = trimNuls(decodeLatin1(content));
    return;
  }

  if (id.startsWith("T")) {
    frame.value = decodeTextFrame(content);
    return;
  }

  // Everything else is opaque: report its size rather than pretending to read it.
  frame.value = `${content.length} bytes of data`;
}

function readApic(content: Uint8Array, major: number): Id3Picture | null {
  if (content.length < 4) return null;
  const encoding = content[0] ?? 0;
  let at = 1;
  let mime: string;

  if (major === 2) {
    // ID3v2.2's PIC stores a three character format, not a MIME type.
    const format = ascii(content, at, 3).toUpperCase();
    mime =
      format === "PNG"
        ? "image/png"
        : format === "JPG"
          ? "image/jpeg"
          : `image/${format.toLowerCase()}`;
    at += 3;
  } else {
    const split = splitAtTerminator(content, at, 0);
    mime = split.text || "image/";
    at = split.next;
  }

  const pictureType = content[at] ?? 0;
  at += 1;
  const description = splitAtTerminator(content, at, encoding);
  at = description.next;

  return {
    mime: mime.includes("/") ? mime : `image/${mime.toLowerCase()}`,
    pictureType,
    typeLabel: PICTURE_TYPES[pictureType] ?? `Type ${pictureType}`,
    description: description.text,
    bytes: content.slice(at),
  };
}

/** The first frame with this id that carried a value. */
function frameValue(info: Id3Info, id: string): string {
  return info.frames.find((frame) => frame.id === id && frame.value)?.value ?? "";
}

function fillTagFromFrames(info: Id3Info): void {
  const tag = info.tag;
  tag.title = frameValue(info, "TIT2");
  tag.artist = frameValue(info, "TPE1");
  tag.albumArtist = frameValue(info, "TPE2");
  tag.album = frameValue(info, "TALB");
  tag.track = frameValue(info, "TRCK");
  tag.disc = frameValue(info, "TPOS");
  tag.composer = frameValue(info, "TCOM");
  tag.genre = resolveGenre(frameValue(info, "TCON"));

  // v2.4 replaced TYER with TDRC, which holds a full ISO date; the year is the
  // part a form can meaningfully edit.
  const year = frameValue(info, "TYER") || frameValue(info, "TDRC") || frameValue(info, "TDRL");
  tag.year = year.slice(0, 4);

  const comment = info.frames.find((frame) => frame.id === "COMM" && frame.value);
  tag.comment = comment?.value ?? "";
}

/**
 * Read every tag a file carries.
 *
 * Never throws for a file that simply has no tag: an untagged MP3 is a normal
 * input for a tag editor, and it comes back with `version: "none"` and an
 * empty tag ready to fill in.
 */
export function parseId3(bytes: Uint8Array): Id3Info {
  if (bytes.length === 0) {
    throw new ToolError(
      "empty-input",
      "The file is empty: it holds zero bytes.",
      "Check the file saved correctly, then drop it again.",
    );
  }
  if (bytes.length > MAX_BYTES) {
    throw new ToolError(
      "too-large",
      `This file is ${formatBytes(bytes.length)}, past the ${formatBytes(MAX_BYTES)} limit.`,
      "Tag editing reads the whole file into memory. Use a desktop tagger for a file this size.",
    );
  }

  if (isFlac(bytes)) return parseFlac(bytes);

  const v1 = parseId3v1(bytes);
  const trailer = trailerSize(bytes, v1);

  const info: Id3Info = {
    container: "mp3",
    version: "none",
    major: 0,
    revision: 0,
    tagSize: 0,
    flags: { unsynchronized: false, extendedHeader: false, experimental: false, footer: false },
    frames: [],
    tag: emptyTag(),
    audioOffset: 0,
    audioSize: Math.max(0, bytes.length - trailer),
    fileSize: bytes.length,
    v1,
    warnings: [],
  };

  if (ascii(bytes, 0, 3) === "ID3" && bytes.length > 10) {
    const major = bytes[3] ?? 0;
    const revision = bytes[4] ?? 0;
    const rawFlags = bytes[5] ?? 0;
    const declared = readSyncsafe(bytes, 6);

    if (major > 4) {
      throw new ToolError(
        "unsupported-tag",
        `This file carries an ID3v2.${major} tag, a version that does not exist yet.`,
        "Check the file is really an MP3. This tool reads ID3v2.2, v2.3 and v2.4.",
      );
    }

    const flags: Id3Flags = {
      unsynchronized: (rawFlags & 0x80) !== 0,
      extendedHeader: (rawFlags & 0x40) !== 0,
      experimental: (rawFlags & 0x20) !== 0,
      footer: major >= 4 && (rawFlags & 0x10) !== 0,
    };

    const bodyEnd = Math.min(bytes.length, 10 + declared);
    if (10 + declared > bytes.length) {
      info.warnings.push(
        `The tag header claims ${declared} bytes but only ${bytes.length - 10} follow it.`,
      );
    }

    let body = bytes.subarray(10, bodyEnd);
    if (flags.unsynchronized) body = deunsynchronize(body);
    if (flags.extendedHeader) body = body.subarray(skipExtendedHeader(body, major, info.warnings));

    info.version = `ID3v2.${major}.${revision}`;
    info.major = major;
    info.revision = revision;
    info.flags = flags;
    info.tagSize = 10 + declared + (flags.footer ? 10 : 0);
    info.audioOffset = Math.min(bytes.length, info.tagSize);
    info.audioSize = Math.max(0, bytes.length - info.audioOffset - trailer);

    parseFrames(body, major, flags.unsynchronized, info);
    fillTagFromFrames(info);
  }

  // With no ID3v2 tag, the v1 trailer is the tag.
  if (info.version === "none" && v1) {
    info.version = `ID3v${v1.version}`;
    info.tag = {
      title: v1.title,
      artist: v1.artist,
      albumArtist: "",
      album: v1.album,
      year: v1.year,
      track: v1.track ? String(v1.track) : "",
      disc: "",
      genre: v1.genre ?? "",
      composer: "",
      comment: v1.comment,
    };
  }

  info.stream = readStreamInfo(bytes, info.audioOffset, info.audioSize);
  return info;
}

/** The audio frames alone: the file with every tag stripped off both ends. */
export function audioBytesOf(bytes: Uint8Array, info: Id3Info): Uint8Array {
  return bytes.subarray(info.audioOffset, info.audioOffset + info.audioSize);
}

/* ------------------------------------------------------------------ */
/* ID3v2.3 writing                                                     */
/* ------------------------------------------------------------------ */

function encodeLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function isLatin1(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0xff) return false;
  }
  return true;
}

function encodeUtf16WithBom(text: string): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[2 + i * 2] = code & 0xff;
    out[3 + i * 2] = code >> 8;
  }
  return out;
}

/**
 * ID3v2.3 has no UTF-8: the choice is Latin-1 or UTF-16 with a byte order
 * mark. Latin-1 is used whenever it can hold the text, because it halves the
 * frame and every player reads it.
 */
function encodeTextValue(text: string): { encoding: number; bytes: Uint8Array } {
  return isLatin1(text)
    ? { encoding: 0, bytes: encodeLatin1(text) }
    : { encoding: 1, bytes: encodeUtf16WithBom(text) };
}

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

function buildFrame(id: string, body: Uint8Array): Uint8Array {
  const frame = new Uint8Array(10 + body.length);
  for (let i = 0; i < 4; i++) frame[i] = id.charCodeAt(i);
  frame[4] = (body.length >>> 24) & 0xff;
  frame[5] = (body.length >>> 16) & 0xff;
  frame[6] = (body.length >>> 8) & 0xff;
  frame[7] = body.length & 0xff;
  return frame;
}

function textFrame(id: string, text: string): Uint8Array | null {
  const value = text.trim();
  if (value.length === 0) return null;
  const { encoding, bytes } = encodeTextValue(value);
  const body = concat([new Uint8Array([encoding]), bytes]);
  const frame = buildFrame(id, body);
  frame.set(body, 10);
  return frame;
}

function commentFrame(text: string): Uint8Array | null {
  const value = text.trim();
  if (value.length === 0) return null;
  const { encoding, bytes } = encodeTextValue(value);
  const terminator = encoding === 1 ? new Uint8Array([0, 0]) : new Uint8Array([0]);
  const body = concat([
    new Uint8Array([encoding]),
    encodeLatin1("eng"),
    terminator, // empty description
    bytes,
  ]);
  const frame = buildFrame("COMM", body);
  frame.set(body, 10);
  return frame;
}

function pictureFrame(cover: Id3Picture): Uint8Array {
  const description = cover.description.slice(0, 60);
  const { encoding, bytes: descriptionBytes } = encodeTextValue(description);
  const terminator = encoding === 1 ? new Uint8Array([0, 0]) : new Uint8Array([0]);
  const body = concat([
    new Uint8Array([encoding]),
    encodeLatin1(cover.mime || "image/jpeg"),
    new Uint8Array([0]),
    new Uint8Array([cover.pictureType]),
    descriptionBytes,
    terminator,
    cover.bytes,
  ]);
  const frame = buildFrame("APIC", body);
  frame.set(body, 10);
  return frame;
}

/** A 128 byte ID3v1.1 trailer built from the same fields. */
export function buildId3v1(tag: EditableTag): Uint8Array {
  const out = new Uint8Array(128);
  out.set(encodeLatin1("TAG"), 0);

  const put = (text: string, offset: number, length: number) => {
    out.set(encodeLatin1(text.slice(0, length)), offset);
  };
  put(tag.title, 3, 30);
  put(tag.artist, 33, 30);
  put(tag.album, 63, 30);
  put(tag.year, 93, 4);
  put(tag.comment, 97, 28);

  const track = Number.parseInt(tag.track, 10);
  if (Number.isFinite(track) && track > 0 && track < 256) {
    out[125] = 0;
    out[126] = track;
  }
  out[127] = genreIndexFor(tag.genre);
  return out;
}

/**
 * Rebuild the file: a fresh ID3v2.3 tag, then padding, then the audio exactly
 * as it was. Nothing is re-encoded, so the audio is bit identical to the input
 * and the only bytes that changed are the ones describing it.
 */
export function buildId3(
  tag: EditableTag,
  audioBytes: Uint8Array,
  options: BuildOptions = {},
): Uint8Array {
  const { cover, padding = DEFAULT_PADDING, writeId3v1 = false } = options;

  if (cover && cover.bytes.length > MAX_COVER_BYTES) {
    throw new ToolError(
      "cover-too-large",
      `The cover art is ${formatBytes(cover.bytes.length)}, past the ${formatBytes(MAX_COVER_BYTES)} limit.`,
      "Shrink the image first, or remove the cover art before saving.",
    );
  }
  if (padding < 0 || padding > 1024 * 1024) {
    throw new ToolError(
      "invalid-padding",
      "Tag padding must be between 0 and 1048576 bytes.",
      "Leave the padding at its default of 1024 bytes unless you have a reason to change it.",
    );
  }

  const frames: Uint8Array[] = [];
  const push = (frame: Uint8Array | null) => {
    if (frame) frames.push(frame);
  };

  push(textFrame("TIT2", tag.title));
  push(textFrame("TPE1", tag.artist));
  push(textFrame("TPE2", tag.albumArtist));
  push(textFrame("TALB", tag.album));
  push(textFrame("TYER", tag.year));
  push(textFrame("TRCK", tag.track));
  push(textFrame("TPOS", tag.disc));
  push(textFrame("TCON", tag.genre));
  push(textFrame("TCOM", tag.composer));
  push(commentFrame(tag.comment));
  if (cover && cover.bytes.length > 0) push(pictureFrame(cover));

  const body = concat(frames);
  const tagSize = body.length + padding;

  const header = new Uint8Array(10);
  header.set(encodeLatin1("ID3"), 0);
  header[3] = 3;
  header[4] = 0;
  header[5] = 0;
  writeSyncsafe(header, 6, tagSize);

  const parts = [header, body, new Uint8Array(padding), audioBytes];
  if (writeId3v1) parts.push(buildId3v1(tag));
  return concat(parts);
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "unknown";
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function tagRows(info: Id3Info): Record<string, string> {
  const rows: Record<string, string> = {};
  const add = (key: string, value: string) => {
    if (value.trim().length > 0) rows[key] = value;
  };

  add("Title", info.tag.title);
  add("Artist", info.tag.artist);
  add("Album artist", info.tag.albumArtist);
  add("Album", info.tag.album);
  add("Year", info.tag.year);
  add("Track", info.tag.track);
  add("Disc", info.tag.disc);
  add("Genre", info.tag.genre);
  add("Composer", info.tag.composer);
  add("Comment", info.tag.comment);

  if (info.cover) {
    rows["Cover art"] =
      `${info.cover.typeLabel}, ${info.cover.mime}, ${formatBytes(info.cover.bytes.length)}`;
  }
  return rows;
}

function fileRows(info: Id3Info): Record<string, string> {
  const rows: Record<string, string> = {
    "Tag version": info.version,
    "File size": formatBytes(info.fileSize),
    "Tag size": info.tagSize > 0 ? formatBytes(info.tagSize) : "no ID3v2 tag",
    "Audio size": formatBytes(info.audioSize),
    "Audio starts at": `byte ${info.audioOffset}`,
    Frames: String(info.frames.length),
  };

  if (info.container === "mp3") {
    const set: string[] = [];
    if (info.flags.unsynchronized) set.push("unsynchronization");
    if (info.flags.extendedHeader) set.push("extended header");
    if (info.flags.experimental) set.push("experimental");
    if (info.flags.footer) set.push("footer");
    rows["Tag flags"] = set.length > 0 ? set.join(", ") : "none set";
    rows["ID3v1 trailer"] = info.v1 ? `present, ID3v${info.v1.version}` : "none";
  }

  if (info.stream) {
    rows["Audio format"] = info.stream.codec;
    rows.Bitrate = `${info.stream.bitrate} kbps${info.stream.vbr ? " average, variable" : ""}`;
    rows["Sample rate"] = `${info.stream.sampleRate} Hz`;
    rows.Channels = info.stream.channelMode;
    rows.Duration = formatDuration(info.stream.durationSeconds);
  }

  if (info.warnings.length > 0) rows.Warnings = info.warnings.join(" ");
  return rows;
}

function frameRows(info: Id3Info): Record<string, string> {
  const rows: Record<string, string> = {};
  info.frames.forEach((frame, index) => {
    const key = `${String(index + 1).padStart(2, "0")}. ${frame.rawId} (${frame.label})`;
    const parts = [frame.value ?? "", `${frame.size} bytes`];
    if (frame.description) parts.unshift(`description: ${frame.description}`);
    if (frame.language) parts.unshift(`language: ${frame.language}`);
    rows[key] = parts.filter(Boolean).join(" | ");
  });
  if (Object.keys(rows).length === 0) rows["No frames"] = "This file carries no ID3v2 frames.";
  return rows;
}

/**
 * The text surface of the tool. The bespoke panel does the editing; this is
 * what the pipeline, the shell and a copied result see.
 */
export function run(input: Uint8Array | string, opts: Mp3TagOpts): Record<string, string> {
  const bytes = toBytes(input);
  const info = parseId3(bytes);

  if (info.container === "mp3" && info.version === "none" && !info.stream) {
    throw new ToolError(
      "not-audio",
      "This does not look like an MP3 or a FLAC file: there is no ID3 tag and no MPEG audio frame.",
      "Drop an .mp3, .mp2 or .flac file. Other formats keep their tags somewhere else entirely.",
    );
  }

  const view = typeof opts?.view === "string" ? opts.view : "tags";
  if (view === "frames") return frameRows(info);
  if (view === "all") return { ...tagRows(info), ...fileRows(info), ...frameRows(info) };
  return { ...tagRows(info), ...fileRows(info) };
}

export default { run } satisfies ToolLogic<Uint8Array | string, Record<string, string>, Mp3TagOpts>;
