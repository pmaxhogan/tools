/**
 * Built in struct templates for the hex viewer.
 *
 * A sanctioned data file: no logic lives here, only the template source text
 * that `parseTemplate` in ./index.ts reads. The comment lines inside each
 * template are shown verbatim in the template editor, so they are user facing
 * prose and follow the same copy rules as the rest of the site.
 *
 * The template language is documented in ./index.ts. The short version:
 *
 *   u8 name              one unsigned byte
 *   u16le / u16be        16 bit integer, little or big endian (also i16)
 *   u32le / u32be        32 bit integer (also i32)
 *   u64le / u64be        64 bit integer, read as a bigint (also i64)
 *   f32le / f64be        IEEE 754 float or double
 *   bytes[n] name        n raw bytes, shown as hex
 *   char[n] name         n bytes of ASCII, trailing NUL padding trimmed
 *   utf8[n] name         n bytes decoded as UTF-8
 *   utf16le[n] name      n bytes decoded as UTF-16LE (also utf16be)
 *   octal[n] name        n bytes of ASCII digits read as base 8
 *   cstring name         bytes up to the next NUL
 *   skip n               advance n bytes
 *   align n              advance to the next multiple of n
 *   @0x3c                seek to an absolute offset
 *   repeat n { ... }     run the block n times
 *   repeat * { ... }     run the block until the bytes run out
 *   if name == 2 { ... } run the block when an earlier field matches
 *
 * Anywhere a count or an offset is written you may instead name a field parsed
 * earlier, optionally with a constant added or subtracted: `skip length`,
 * `@peHeaderOffset`, `skip size - 8`, `utf8[nameLength] fileName`.
 */

export interface BuiltinTemplate {
  /** Stable id. Must match the `template` select option values in meta.ts. */
  id: string;
  /** Human label for the picker. */
  label: string;
  /** Template source text. */
  text: string;
}

const PNG = `# PNG: an 8 byte signature, the IHDR chunk, then every chunk after it.
bytes[8] signature
u32be ihdrLength
char[4] ihdrType
u32be width
u32be height
u8 bitDepth
u8 colorType
u8 compression
u8 filter
u8 interlace
u32be ihdrCrc
repeat * {
  u32be length
  char[4] type
  skip length
  u32be crc
}
`;

const BMP = `# Windows bitmap: the 14 byte file header then the DIB info header.
char[2] signature
u32le fileSize
u16le reserved1
u16le reserved2
u32le pixelDataOffset
u32le dibHeaderSize
i32le width
i32le height
u16le colorPlanes
u16le bitsPerPixel
u32le compression
u32le imageSize
i32le xPixelsPerMeter
i32le yPixelsPerMeter
u32le paletteColors
u32le importantColors
`;

const ZIP = `# ZIP local file header. Every member of the archive starts with one.
# Sizes read 0 when the entry uses a streamed data descriptor instead.
char[4] signature
u16le versionNeeded
u16le flags
u16le compressionMethod
u16le modTime
u16le modDate
u32le crc32
u32le compressedSize
u32le uncompressedSize
u16le nameLength
u16le extraLength
utf8[nameLength] fileName
bytes[extraLength] extraField
`;

const ELF = `# ELF header. class 1 is 32 bit and 2 is 64 bit, endian 1 is little
# and 2 is big. The multi byte fields below assume a little endian file,
# which covers x86-64 and aarch64; flip them to be for a big endian target.
char[4] magic
u8 class
u8 endian
u8 elfVersion
u8 osAbi
u8 abiVersion
skip 7
u16le type
u16le machine
u32le version
if class == 2 {
  u64le entryPoint
  u64le programHeaderOffset
  u64le sectionHeaderOffset
}
if class == 1 {
  u32le entryPoint
  u32le programHeaderOffset
  u32le sectionHeaderOffset
}
`;

const PE = `# DOS stub then the PE header it points at. e_lfanew lives at 0x3c
# and holds the absolute offset of the PE signature.
char[2] dosSignature
@0x3c
u32le peHeaderOffset
@peHeaderOffset
char[4] peSignature
u16le machine
u16le sectionCount
u32le timeDateStamp
u32le symbolTableOffset
u32le symbolCount
u16le optionalHeaderSize
u16le characteristics
u16le optionalMagic
`;

const WAV = `# RIFF container with a WAVE payload: the file header then the fmt chunk.
char[4] riff
u32le fileSize
char[4] format
char[4] fmtChunkId
u32le fmtChunkSize
u16le audioFormat
u16le channels
u32le sampleRate
u32le byteRate
u16le blockAlign
u16le bitsPerSample
`;

const GIF = `# GIF header and logical screen descriptor.
# packed holds the global color table flag, color resolution, and table size.
char[3] signature
char[3] version
u16le width
u16le height
u8 packed
u8 backgroundColorIndex
u8 pixelAspectRatio
`;

const MP4 = `# ISO base media atom walker: every atom is a big endian size,
# a four character type, then size minus 8 bytes of payload.
# A size of 1 means the real size is a 64 bit value that follows the type,
# and a size of 0 means the atom runs to the end of the file.
repeat * {
  u32be size
  char[4] type
  skip size - 8
}
`;

const TAR = `# POSIX tar header block, 512 bytes per entry.
# tar stores its numbers as ASCII octal text, so mode, uid, gid, size and
# mtime are read as base 8 here and shown as ordinary decimal numbers.
char[100] name
octal[8] mode
octal[8] uid
octal[8] gid
octal[12] size
octal[12] mtime
char[8] checksum
char[1] typeFlag
char[100] linkName
char[6] ustarMagic
char[2] ustarVersion
char[32] ownerName
char[32] groupName
`;

const MACHO = `# Mach-O header. Read the magic as hex: feedface is 32 bit big endian,
# feedfacf is 64 bit big endian, cefaedfe and cffaedfe are their little
# endian twins, and cafebabe is a universal (fat) binary or a Java class.
# The fields below assume a little endian Mach-O, which is every Apple
# target since the PowerPC era.
bytes[4] magic
u32le cpuType
u32le cpuSubtype
u32le fileType
u32le loadCommandCount
u32le loadCommandBytes
u32le flags
`;

const BOM = `# Byte order mark sniffing. Read the bom row as hex:
# fffe is UTF-16LE, feff is UTF-16BE, and efbbbf is a UTF-8 BOM.
# The preview below decodes the rest of the window as UTF-16LE, so it only
# reads correctly for an fffe file.
bytes[2] bom
utf16le[16] previewUtf16le
@0
utf8[16] previewUtf8
`;

/**
 * Every built in template, in picker order. The ids are part of the tool's
 * option contract: meta.ts lists exactly these plus "auto" and "custom", and a
 * test asserts the two lists stay in sync.
 */
export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  { id: "png", label: "PNG image", text: PNG },
  { id: "gif", label: "GIF image", text: GIF },
  { id: "bmp", label: "BMP bitmap", text: BMP },
  { id: "zip", label: "ZIP local file header", text: ZIP },
  { id: "tar", label: "TAR header block", text: TAR },
  { id: "elf", label: "ELF header", text: ELF },
  { id: "pe", label: "PE and DOS header", text: PE },
  { id: "macho", label: "Mach-O header", text: MACHO },
  { id: "wav", label: "WAV and RIFF header", text: WAV },
  { id: "mp4", label: "MP4 atom walker", text: MP4 },
  { id: "bom", label: "Byte order mark", text: BOM },
];

/** Look one up by id. Returns undefined for "auto", "custom", and typos. */
export function findTemplate(id: string): BuiltinTemplate | undefined {
  return BUILTIN_TEMPLATES.find((t) => t.id === id);
}
