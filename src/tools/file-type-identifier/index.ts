import { fileTypeFromBuffer } from "file-type";
import { ToolError, type ToolLogic } from "../types";

export interface FileIdOpts {
  [key: string]: unknown;
}

export type FileIdResult = Record<string, string>;

/** Friendly names for the extensions file-type recognizes most often. */
const TYPE_LABELS: Record<string, string> = {
  png: "PNG image",
  jpg: "JPEG image",
  gif: "GIF image",
  webp: "WebP image",
  bmp: "BMP image",
  ico: "Windows icon",
  avif: "AVIF image",
  heic: "HEIC image",
  heif: "HEIF image",
  tif: "TIFF image",
  cr2: "Canon RAW image",
  svg: "SVG image",
  pdf: "PDF document",
  zip: "ZIP archive",
  gz: "GZIP archive",
  tar: "TAR archive",
  rar: "RAR archive",
  "7z": "7-Zip archive",
  bz2: "BZip2 archive",
  xz: "XZ archive",
  zst: "Zstandard archive",
  docx: "Word document (DOCX)",
  xlsx: "Excel spreadsheet (XLSX)",
  pptx: "PowerPoint presentation (PPTX)",
  odt: "OpenDocument text (ODT)",
  ods: "OpenDocument spreadsheet (ODS)",
  epub: "EPUB ebook",
  jar: "Java archive (JAR)",
  apk: "Android package (APK)",
  mp3: "MP3 audio",
  wav: "WAV audio",
  flac: "FLAC audio",
  ogg: "Ogg audio/video",
  m4a: "M4A audio",
  mp4: "MP4 video",
  mov: "QuickTime video",
  webm: "WebM video",
  avi: "AVI video",
  mkv: "Matroska video",
  wasm: "WebAssembly module",
  exe: "Windows executable",
  elf: "ELF executable (Linux)",
  ttf: "TrueType font",
  otf: "OpenType font",
  woff: "WOFF font",
  woff2: "WOFF2 font",
  sqlite: "SQLite database",
};

function labelFor(ext: string, mime: string): string {
  const known = TYPE_LABELS[ext];
  if (known) return known;
  const readable = ext.toUpperCase();
  const top = mime.split("/")[0];
  if (top === "image") return `${readable} image`;
  if (top === "audio") return `${readable} audio`;
  if (top === "video") return `${readable} video`;
  if (top === "font") return `${readable} font`;
  return `${readable} file`;
}

/** Human-readable byte size, e.g. "1.21 KB (1,234 bytes)". */
function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex++;
  } while (value >= 1024 && unitIndex < units.length - 1);
  const rounded = value < 10 ? value.toFixed(2) : value.toFixed(1);
  return `${rounded} ${units[unitIndex]} (${n.toLocaleString("en-US")} bytes)`;
}

/** First 16 bytes as spaced, uppercase hex, e.g. "89 50 4E 47 ...". */
function firstBytesHex(bytes: Uint8Array): string {
  return [...bytes.slice(0, 16)]
    .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
    .join(" ");
}

interface BomInfo {
  encoding: "UTF-8" | "UTF-16LE" | "UTF-16BE";
  length: number;
}

function detectBom(bytes: Uint8Array): BomInfo | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: "UTF-8", length: 3 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: "UTF-16LE", length: 2 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: "UTF-16BE", length: 2 };
  }
  return undefined;
}

function detectLineEnding(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lfOnly = (text.match(/(?<!\r)\n/g) ?? []).length;
  const crOnly = (text.match(/\r(?!\n)/g) ?? []).length;
  const kinds = [crlf > 0, lfOnly > 0, crOnly > 0].filter(Boolean).length;
  if (kinds > 1) return "Mixed";
  if (crlf > 0) return "CRLF";
  if (lfOnly > 0) return "LF";
  if (crOnly > 0) return "CR";
  return "None (single line)";
}

/** Delimiter-separated text: 2+ non-empty lines with a consistent, positive column count. */
function detectDelimited(text: string): string | undefined {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return undefined;
  const sample = lines.slice(0, 25);
  for (const [delim, name] of [
    ["\t", "TSV"],
    [",", "CSV"],
  ] as const) {
    const counts = sample.map((l) => l.split(delim).length - 1);
    if (counts[0]! > 0 && counts.every((c) => c === counts[0])) return name;
  }
  return undefined;
}

function isMarkdownish(text: string): boolean {
  const hasHeading = /^#{1,6}\s+\S/m.test(text);
  const hasLink = /\[[^\]]+\]\([^)]+\)/.test(text);
  const hasFence = /^```/m.test(text);
  const hasBoldOrList = /\*\*[^*]+\*\*/.test(text) || /^[-*]\s+\S/m.test(text);
  return (
    hasHeading || hasLink || hasFence || (hasBoldOrList && /^#{1,6}\s|\[[^\]]+\]\(/m.test(text))
  );
}

function isJsIsh(text: string): boolean {
  const patterns = [
    /\bfunction\s*\w*\s*\(/,
    /=>\s*[{(]/,
    /\bconst\s+\w+\s*=/,
    /\blet\s+\w+\s*=/,
    /\bimport\s+.+\s+from\s+['"]/,
    /\bexport\s+(default\s+)?(function|class|const)/,
    /console\.log\(/,
  ];
  return patterns.filter((p) => p.test(text)).length >= 2;
}

function isYamlIsh(text: string): boolean {
  const lines = text
    .split(/\r\n|\r|\n/)
    .filter((l) => l.trim().length > 0 && !l.trim().startsWith("#"));
  if (lines.length < 2) return false;
  const yamlLike = lines.filter(
    (l) =>
      /^[\w.-]+:\s?.*$/.test(l.trim()) || /^-\s+\S/.test(l.trim()) || /^\s+[\w.-]+:\s?.*$/.test(l),
  );
  return yamlLike.length / lines.length >= 0.7;
}

function isIniIsh(text: string): boolean {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  const iniLike = lines.filter(
    (l) =>
      /^\[[^\]]+]$/.test(l.trim()) ||
      /^[\w.-]+\s*=\s*.*$/.test(l.trim()) ||
      l.trim().startsWith(";"),
  );
  return iniLike.length / lines.length >= 0.7;
}

function classifyText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "Empty text";

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "JSON";
    } catch {
      // fall through
    }
  }

  if (trimmed.startsWith("<")) {
    const head = trimmed.slice(0, 200).toLowerCase();
    if (/^<\?xml/.test(trimmed) && /<svg[\s>]/.test(head)) return "SVG";
    if (/<svg[\s>]/.test(head)) return "SVG";
    if (/<!doctype html/i.test(head) || /<html[\s>]/.test(head)) return "HTML";
    return "XML";
  }

  const delimited = detectDelimited(trimmed);
  if (delimited) return delimited;

  if (isMarkdownish(trimmed)) return "Markdown";
  if (isJsIsh(trimmed)) return "JavaScript/TypeScript";
  if (isYamlIsh(trimmed)) return "YAML";
  if (isIniIsh(trimmed)) return "INI";

  return "Plain text";
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function run(input: Uint8Array | string, _opts: FileIdOpts): Promise<FileIdResult> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;

  if (!bytes || bytes.length === 0) {
    throw new ToolError(
      "empty-input",
      "No file or content was provided.",
      "Drop a file onto the input, use the file picker, or paste some content.",
    );
  }

  const sizeRow = humanSize(bytes.length);
  const hexRow = firstBytesHex(bytes);
  const textResult = (text: string, encodingLabel: string): FileIdResult => {
    const lineCount = text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length;
    return {
      "Detected type": classifyText(text),
      Encoding: encodingLabel,
      "Line ending": detectLineEnding(text),
      "Line count": String(lineCount),
      Size: sizeRow,
      "First bytes": hexRow,
    };
  };

  // A UTF-16 byte order mark is checked before magic-byte detection: file-type's
  // MPEG-1 Layer 1 sync-word check (0xFF 0xFE masked) is bit-identical to the
  // UTF-16LE BOM prefix, so a text file would otherwise misreport as audio/mpeg.
  // Real text with a valid BOM is far more likely than a raw MPEG elementary
  // stream, so a BOM that decodes cleanly wins; a BOM-like prefix that fails to
  // decode falls through to ordinary binary detection below.
  const bom = detectBom(bytes);
  if (bom?.encoding === "UTF-16LE" || bom?.encoding === "UTF-16BE") {
    try {
      const text = new TextDecoder(bom.encoding === "UTF-16LE" ? "utf-16le" : "utf-16be", {
        fatal: true,
      }).decode(bytes.subarray(bom.length));
      return textResult(text, `${bom.encoding} (BOM)`);
    } catch {
      // Not actually UTF-16 text; fall through to binary/UTF-8 detection.
    }
  }

  const detected = await fileTypeFromBuffer(bytes);
  if (detected) {
    return {
      "Detected type": labelFor(detected.ext, detected.mime),
      "MIME type": detected.mime,
      "Typical extension": `.${detected.ext}`,
      "Detection basis": "magic bytes",
      Size: sizeRow,
      "First bytes": hexRow,
    };
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(bom?.encoding === "UTF-8" ? bom.length : 0),
    );
    return textResult(text, bom?.encoding === "UTF-8" ? "UTF-8 (BOM)" : "UTF-8");
  } catch {
    // Not valid UTF-8 either.
  }

  return {
    "Detected type": "Unknown binary",
    Note: "These bytes do not match a known file signature or valid UTF-8/UTF-16 text. This may be a proprietary, encrypted, or truncated format.",
    Size: sizeRow,
    "First bytes": hexRow,
  };
}

export default {
  run,
} satisfies ToolLogic<Uint8Array | string, FileIdResult, FileIdOpts>;
