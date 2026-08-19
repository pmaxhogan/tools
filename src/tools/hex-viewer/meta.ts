import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "hex-viewer",
  matrixSlug: "hex",
  icon: "Binary",
  name: "Hex Viewer",
  description: "Inspect binary files byte by byte with reusable struct templates.",
  category: "Files",
  keywords: [
    "hex viewer online",
    "hex editor browser",
    "view binary file",
    "hex dump",
    "struct template binary parser",
    "inspect file bytes",
    "binary file analyzer",
  ],
  searchTerms: [
    "xxd",
    "hexdump",
    "od command",
    "hex dump viewer",
    "010 editor template",
    "imhex pattern",
    "binary struct parser",
    "file header parser",
    "magic bytes",
    "file signature",
    "strings command",
    "entropy analysis",
    "packed executable check",
    "png chunk viewer",
    "elf header viewer",
    "pe header viewer",
    "tar header",
    "mp4 atom",
  ],
  input: "File",
  output: "text/plain",
  options: [
    {
      kind: "select",
      id: "view",
      label: "View",
      default: "dump",
      options: [
        {
          value: "dump",
          label: "Hex dump",
          synonyms: ["hex", "hexdump", "xxd", "od", "bytes", "grid", "raw"],
        },
        {
          value: "template",
          label: "Struct template",
          synonyms: ["struct", "fields", "header", "parse", "layout", "record"],
        },
        {
          value: "strings",
          label: "Printable strings",
          synonyms: ["strings", "text", "ascii", "utf16", "readable"],
        },
        {
          value: "info",
          label: "File summary",
          synonyms: ["info", "summary", "stats", "entropy", "hash", "sha256", "magic"],
        },
      ],
    },
    {
      kind: "select",
      id: "template",
      label: "Template",
      default: "auto",
      groups: [
        {
          label: "Choose for me",
          synonyms: ["auto", "detect", "guess", "own", "custom", "mine"],
          options: [
            {
              value: "auto",
              label: "Match the magic bytes",
              synonyms: ["auto", "automatic", "detect", "sniff", "guess", "identify"],
            },
            {
              value: "custom",
              label: "My own template",
              synonyms: ["custom", "mine", "hand written", "user", "editor", "manual"],
            },
          ],
        },
        {
          label: "Images",
          synonyms: ["image", "picture", "graphics", "bitmap", "photo"],
          options: [
            {
              value: "png",
              label: "PNG image",
              synonyms: ["png", "ihdr", "chunk", "portable network graphics"],
            },
            { value: "gif", label: "GIF image", synonyms: ["gif", "gif89a", "gif87a", "animated"] },
            { value: "bmp", label: "BMP bitmap", synonyms: ["bmp", "dib", "bitmap", "windows"] },
          ],
        },
        {
          label: "Archives",
          synonyms: ["archive", "compressed", "package", "bundle"],
          options: [
            {
              value: "zip",
              label: "ZIP local file header",
              synonyms: ["zip", "jar", "apk", "docx", "pk", "local file header"],
            },
            {
              value: "tar",
              label: "TAR header block",
              synonyms: ["tar", "ustar", "tarball", "posix", "gnu tar"],
            },
          ],
        },
        {
          label: "Executables",
          synonyms: ["executable", "binary", "program", "object file", "reverse engineering"],
          options: [
            {
              value: "elf",
              label: "ELF header",
              synonyms: ["elf", "linux", "so", "shared object", "readelf"],
            },
            {
              value: "pe",
              label: "PE and DOS header",
              synonyms: ["pe", "exe", "dll", "mz", "windows", "portable executable", "e_lfanew"],
            },
            {
              value: "macho",
              label: "Mach-O header",
              synonyms: ["macho", "mach o", "dylib", "macos", "apple", "otool"],
            },
          ],
        },
        {
          label: "Media containers",
          synonyms: ["media", "audio", "video", "container", "codec"],
          options: [
            {
              value: "wav",
              label: "WAV and RIFF header",
              synonyms: ["wav", "riff", "wave", "avi", "webp", "fmt", "pcm"],
            },
            {
              value: "mp4",
              label: "MP4 atom walker",
              synonyms: ["mp4", "m4a", "mov", "atom", "box", "ftyp", "iso base media", "quicktime"],
            },
          ],
        },
        {
          label: "Text encodings",
          synonyms: ["text", "encoding", "unicode", "charset"],
          options: [
            {
              value: "bom",
              label: "Byte order mark",
              synonyms: ["bom", "utf16", "utf 16", "utf8 bom", "unicode", "endian", "fffe", "feff"],
            },
          ],
        },
      ],
    },
    {
      kind: "text",
      id: "customTemplate",
      label: "Custom template",
      default: "",
      placeholder: "char[4] magic\nu32le size\ncstring name",
    },
    {
      kind: "number",
      id: "offset",
      label: "Start offset (bytes)",
      default: 0,
      min: 0,
      step: 1,
    },
    {
      kind: "number",
      id: "bytesPerRow",
      label: "Bytes per row",
      default: 16,
      min: 8,
      max: 32,
      step: 8,
    },
    { kind: "boolean", id: "uppercase", label: "Uppercase hex", default: false },
  ],
  copy: {
    what: "A hex viewer that reads a file byte by byte in your browser and can also make sense of it. The dump view is the familiar layout: an eight digit offset column, hex bytes in groups of eight, and an ASCII gutter with a dot for every unprintable byte. The template view runs a small struct language over the bytes, so a PNG comes back as width, height, bit depth and a walk of every chunk instead of a wall of hex, and eleven formats ship with a template already written. There is also a strings view that lists printable ASCII and UTF-16LE runs with their offsets, and a summary with the detected type, the SHA-256, the Shannon entropy, and an entropy map that shows where the packed regions are.",
    how: "Drop a file, or paste a hex dump, a base64 string, or plain text you want the bytes of. Leave the template on Match the magic bytes and the right built in template is chosen for you when the signature is recognized, or pick one from the list. Choose My own template and write the struct yourself: one field per line, like char[4] magic then u32le size then cstring name, with skip, align, @offset, repeat and if for the awkward parts. Set the start offset to move the dump window or to begin a template partway into the file.",
    why: "Most online hex viewers upload your file to read it, which is exactly backwards for the files people actually want to inspect: a firmware image, a crash dump, a document from a customer. This one runs entirely in the page, so your files and inputs never leave your device, and it keeps working offline after the first load. The desktop tools that do have struct templates, like 010 Editor and ImHex, are a download and a license away when all you wanted was to check one header. There is no upload, no sign in, no size gate at a few hundred kilobytes, and no ads over the dump.",
    faq: [
      {
        q: "How do I write a struct template?",
        a: 'One statement per line. A field is a type and a name: u8, i8, u16le, u16be, i16le, i16be, u32le, u32be, i32le, i32be, u64le, u64be, i64le, i64be, f32le, f32be, f64le, f64be, plus bytes[n], char[n], utf8[n], utf16le[n], utf16be[n], octal[n] and cstring. The control statements are skip n, align n, @offset to seek, repeat n { } to run a block a fixed number of times, repeat * { } to walk until the bytes run out, and if name == 2 { } to branch on a field already read. Anywhere a count or an offset goes you can name an earlier field, with a constant added or subtracted, so utf8[nameLength] fileName and skip size - 8 both work. Lines starting with # are comments. Every built in template is written in the same language, so open one and edit it.',
      },
      {
        q: "Can it open a large file?",
        a: "It reads files up to 64 MB, and the dump shows 64 KB at a time so the page stays responsive. Use the start offset to move that window to the region you care about. The summary, strings and entropy views read the whole file, not just the window. Past 64 MB a browser tab is the wrong tool and you want something that streams from disk.",
      },
      {
        q: "What does the entropy number tell me?",
        a: "It is Shannon entropy in bits per byte, from 0 when one byte value repeats to 8 when every value appears equally often. Text and source code land around 4 to 5, a typical binary with headers and code sits between 5 and 7, and anything above 7.5 is compressed, encrypted, or packed. The entropy map splits the file into blocks and draws one bar per block, which is how you spot a plain header in front of a compressed payload, or an encrypted section inside an otherwise ordinary executable.",
      },
    ],
  },
};
