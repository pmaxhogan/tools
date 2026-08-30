import { formatBytes } from "@/lib/format";
import { ToolError, type ToolLogic } from "../types";

/**
 * Image to Data URL logic.
 *
 * Two directions over the same grammar. Encoding takes image bytes and returns
 * a `data:` URL plus the CSS and HTML snippets people actually paste. Decoding
 * takes a `data:` URL back apart into its media type, its encoding, and the
 * bytes it carries, so the panel can hand the file back as a download.
 *
 * Base64 is implemented here rather than through `btoa`/`atob` for two reasons:
 * the byte-per-character dance those two need is where most hand rolled
 * versions go wrong on binary input, and a plain table keeps this module pure
 * enough to run in Node under vitest with no shims.
 *
 * The 100 KB warning is not arbitrary. A data URL is 33 percent bigger than the
 * file it inlines, it cannot be cached separately from the document that holds
 * it, and it blocks first paint when it lands in a stylesheet, so past roughly
 * that size a plain `<img src>` or a CSS `url()` to a real file wins.
 */

/* ------------------------------------------------------------------ */
/* options                                                             */
/* ------------------------------------------------------------------ */

export interface ImageToDataUrlOpts {
  /** "auto" reads the direction off the input; the others force it. */
  direction?: "auto" | "encode" | "decode";
  /** Media type to declare when encoding. "auto" sniffs the magic bytes. */
  mediaType?: string;
  /** Which snippet the text output carries. */
  snippet?: "raw" | "css" | "html";
  /** CSS selector used by the css snippet. */
  selector?: string;
  [key: string]: unknown;
}

/** Byte length past which an inline data URL usually costs more than it saves. */
export const INLINE_WARN_BYTES = 100 * 1024;

/* ------------------------------------------------------------------ */
/* base64                                                             */
/* ------------------------------------------------------------------ */

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) table[B64_ALPHABET.charCodeAt(i)] = i;
  // The URL safe alphabet decodes to the same values, so a base64url payload
  // pasted from a JWT or a log line still comes apart.
  table["-".charCodeAt(0)] = 62;
  table["_".charCodeAt(0)] = 63;
  return table;
})();

/** Standard base64 with padding. Pure, and safe on every byte value. */
export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      B64_ALPHABET[(n >> 18) & 63]! +
      B64_ALPHABET[(n >> 12) & 63]! +
      B64_ALPHABET[(n >> 6) & 63]! +
      B64_ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += `${B64_ALPHABET[(n >> 18) & 63]!}${B64_ALPHABET[(n >> 12) & 63]!}==`;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += `${B64_ALPHABET[(n >> 18) & 63]!}${B64_ALPHABET[(n >> 12) & 63]!}${B64_ALPHABET[(n >> 6) & 63]!}=`;
  }
  return out;
}

/** Decode standard or URL safe base64. Whitespace anywhere is ignored. */
export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "").replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let at = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const value = code < 128 ? B64_LOOKUP[code]! : -1;
    if (value < 0) {
      throw new ToolError(
        "bad-base64",
        `The data URL payload contains "${clean[i]}", which is not a base64 character.`,
        "Copy the whole data URL again. A line break inside it is fine, but any other stray character breaks the payload.",
      );
    }
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}

/* ------------------------------------------------------------------ */
/* format sniffing                                                     */
/* ------------------------------------------------------------------ */

interface SniffedFormat {
  mediaType: string;
  extension: string;
  label: string;
}

const UNKNOWN_FORMAT: SniffedFormat = {
  mediaType: "application/octet-stream",
  extension: "bin",
  label: "Unrecognized",
};

function startsWith(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
  if (bytes.length < at + signature.length) return false;
  for (let i = 0; i < signature.length; i++) if (bytes[at + i] !== signature[i]) return false;
  return true;
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let out = "";
  for (let i = 0; i < length && at + i < bytes.length; i++)
    out += String.fromCharCode(bytes[at + i]!);
  return out;
}

/**
 * The media type of a byte run, read from its magic number rather than from a
 * filename. The panel never has to trust `File.type`, which browsers leave
 * empty for anything they do not recognize.
 */
export function sniffFormat(bytes: Uint8Array): SniffedFormat {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { mediaType: "image/png", extension: "png", label: "PNG" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff]))
    return { mediaType: "image/jpeg", extension: "jpg", label: "JPEG" };
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]))
    return { mediaType: "image/gif", extension: "gif", label: "GIF" };
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, 4) === "WEBP")
    return { mediaType: "image/webp", extension: "webp", label: "WebP" };
  if (startsWith(bytes, [0x42, 0x4d]))
    return { mediaType: "image/bmp", extension: "bmp", label: "BMP" };
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00]))
    return { mediaType: "image/x-icon", extension: "ico", label: "ICO" };
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (brand === "avif" || brand === "avis")
      return { mediaType: "image/avif", extension: "avif", label: "AVIF" };
    if (brand.startsWith("hei") || brand.startsWith("mif"))
      return { mediaType: "image/heic", extension: "heic", label: "HEIC" };
  }
  // SVG is text, so it is sniffed by its first meaningful markup rather than
  // by a fixed byte signature.
  // `ascii` reads one byte per character, so a UTF-8 byte order mark arrives as
  // the three separate bytes EF BB BF rather than as one U+FEFF.
  const head = ascii(bytes, 0, 300).replace(/^ï»¿/, "").trimStart();
  if (/^<\?xml[\s\S]*<svg[\s>]/i.test(head) || /^<svg[\s>]/i.test(head))
    return { mediaType: "image/svg+xml", extension: "svg", label: "SVG" };
  return UNKNOWN_FORMAT;
}

/** The filename extension a media type should be saved under. */
export function extensionForMediaType(mediaType: string): string {
  const base = mediaType.split(";")[0]!.trim().toLowerCase();
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/avif": "avif",
    "image/heic": "heic",
    "image/bmp": "bmp",
    "image/x-icon": "ico",
    "image/vnd.microsoft.icon": "ico",
    "image/svg+xml": "svg",
    "image/tiff": "tif",
    "text/plain": "txt",
    "text/css": "css",
    "text/html": "html",
    "application/json": "json",
    "application/pdf": "pdf",
  };
  return map[base] ?? "bin";
}

/* ------------------------------------------------------------------ */
/* building                                                            */
/* ------------------------------------------------------------------ */

export interface BuiltDataUrl {
  dataUrl: string;
  mediaType: string;
  /** Bytes the source file occupies on disk. */
  sourceBytes: number;
  /** Characters in the finished data URL, which is what a page has to carry. */
  urlLength: number;
  /** How much larger the inline form is, as a multiplier of the source. */
  overhead: number;
  format: SniffedFormat;
}

/**
 * Exact character count of a base64 data URL without building the string, so a
 * panel can warn about a 40 MB file before spending the memory on it.
 */
export function estimateDataUrlLength(byteLength: number, mediaType: string): number {
  return "data:".length + mediaType.length + ";base64,".length + Math.ceil(byteLength / 3) * 4;
}

/** Encode bytes as a base64 data URL and report what that cost. */
export function buildDataUrl(bytes: Uint8Array, mediaType?: string): BuiltDataUrl {
  if (bytes.length === 0) {
    throw new ToolError(
      "empty-input",
      "That file is empty, so there is nothing to encode.",
      "Drop an image with actual content in it, or paste a data URL to decode instead.",
    );
  }
  const format = sniffFormat(bytes);
  const type = mediaType && mediaType !== "auto" ? mediaType : format.mediaType;
  const dataUrl = `data:${type};base64,${encodeBase64(bytes)}`;
  return {
    dataUrl,
    mediaType: type,
    sourceBytes: bytes.length,
    urlLength: dataUrl.length,
    overhead: dataUrl.length / bytes.length,
    format,
  };
}

/** The CSS rule people actually paste, with the URL quoted. */
export function cssSnippet(dataUrl: string, selector = ".hero"): string {
  const safeSelector = selector.trim() || ".hero";
  return `${safeSelector} {\n  background-image: url("${dataUrl}");\n  background-size: cover;\n  background-position: center;\n}`;
}

/** The img tag people actually paste. */
export function htmlSnippet(dataUrl: string, alt = "Inline image"): string {
  return `<img src="${dataUrl}" alt="${alt.replace(/"/g, "&quot;")}" />`;
}

/* ------------------------------------------------------------------ */
/* parsing                                                             */
/* ------------------------------------------------------------------ */

export interface ParsedDataUrl {
  mediaType: string;
  /** Parameters after the media type, e.g. `charset=utf-8`. */
  parameters: string[];
  encoding: "base64" | "percent";
  bytes: Uint8Array;
  /** Suggested filename extension for the payload. */
  extension: string;
  /** Characters in the data URL as pasted. */
  urlLength: number;
}

const DATA_URL_HEAD = /^data:([^,]*),/i;

/**
 * Take a `data:` URL apart. Handles both payload encodings the RFC allows:
 * `;base64` and the default percent encoded form that CSS often carries for an
 * inline SVG.
 */
export function parseDataUrl(text: string): ParsedDataUrl {
  const trimmed = text.trim();
  const head = DATA_URL_HEAD.exec(trimmed);
  if (!head) {
    throw new ToolError(
      "not-a-data-url",
      "That text is not a data URL, so there is nothing to decode.",
      'A data URL starts with "data:" and has a comma before the payload, like data:image/png;base64,iVBORw0K...',
    );
  }
  const meta = head[1]!;
  const payload = trimmed.slice(head[0].length);
  const parts = meta.split(";").map((p) => p.trim());
  const isBase64 = parts[parts.length - 1]?.toLowerCase() === "base64";
  if (isBase64) parts.pop();

  const mediaType = parts.shift() || "text/plain";
  const bytes = isBase64 ? decodeBase64(payload) : decodePercent(payload);
  if (bytes.length === 0) {
    throw new ToolError(
      "empty-payload",
      "That data URL carries no bytes after the comma.",
      "Paste the whole URL. Copying from devtools sometimes truncates it at the first line break.",
    );
  }
  return {
    mediaType,
    parameters: parts,
    encoding: isBase64 ? "base64" : "percent",
    bytes,
    extension: extensionForMediaType(mediaType),
    urlLength: trimmed.length,
  };
}

/** Percent decode a payload into UTF-8 bytes, the non-base64 data URL form. */
function decodePercent(payload: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < payload.length; i++) {
    const ch = payload[i]!;
    if (ch === "%") {
      const hex = payload.slice(i + 1, i + 3);
      if (!/^[0-9a-f]{2}$/i.test(hex)) {
        throw new ToolError(
          "bad-percent-escape",
          `The payload has a "%" that is not followed by two hex digits.`,
          "Either the URL was truncated, or a literal percent sign needs to be written as %25.",
        );
      }
      out.push(parseInt(hex, 16));
      i += 2;
      continue;
    }
    // Everything else is plain ASCII in a well formed data URL, but a pasted
    // one may still carry raw UTF-8, so encode it rather than dropping it.
    const encoded = new TextEncoder().encode(ch);
    for (const b of encoded) out.push(b);
  }
  return new Uint8Array(out);
}

/** True when the text looks like a data URL, used to pick a direction. */
export function looksLikeDataUrl(text: string): boolean {
  return DATA_URL_HEAD.test(text.trim());
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

function optString(opts: ImageToDataUrlOpts | undefined, key: string, fallback: string): string {
  const raw = opts?.[key];
  return typeof raw === "string" && raw.trim() !== "" ? raw : fallback;
}

function warning(urlLength: number): string | null {
  if (urlLength <= INLINE_WARN_BYTES) return null;
  return `This data URL is ${formatBytes(urlLength)} of text. Past roughly 100 KB an inline image usually costs more than it saves, because it cannot be cached separately from the page and it delays first paint.`;
}

export function run(
  input: Uint8Array | string,
  opts: ImageToDataUrlOpts = {},
): Record<string, string> {
  const direction = optString(opts, "direction", "auto");

  if (typeof input === "string") {
    const text = input.trim();
    if (text === "") {
      throw new ToolError(
        "empty-input",
        "Nothing to convert yet.",
        "Drop an image to get its data URL, or paste a data URL to decode it back into a file.",
      );
    }
    if (direction === "encode") {
      // Text pasted into an encoder is treated as file content, which is how
      // an SVG or a snippet of CSS gets inlined.
      return encodeReport(new TextEncoder().encode(text), opts);
    }
    if (direction === "decode" || looksLikeDataUrl(text)) return decodeReport(text);
    throw new ToolError(
      "not-a-data-url",
      "That text is not a data URL, so there is nothing to decode.",
      "Drop an image file to encode one, or paste a URL that starts with data: to decode it.",
    );
  }

  if (direction === "decode") {
    return decodeReport(new TextDecoder().decode(input));
  }
  return encodeReport(input, opts);
}

function encodeReport(bytes: Uint8Array, opts: ImageToDataUrlOpts): Record<string, string> {
  const built = buildDataUrl(bytes, optString(opts, "mediaType", "auto"));
  const snippet = optString(opts, "snippet", "raw");
  const selector = optString(opts, "selector", ".hero");

  const out: Record<string, string> = {
    Direction: "Encoded to a data URL",
    Format: `${built.format.label} (${built.mediaType})`,
    "File size": formatBytes(built.sourceBytes),
    "Data URL size": `${formatBytes(built.urlLength)} of text`,
    Overhead: `${Math.round((built.overhead - 1) * 100)}% larger than the file`,
  };
  const note = warning(built.urlLength);
  if (note) out["Size warning"] = note;

  if (snippet === "css") out["CSS background"] = cssSnippet(built.dataUrl, selector);
  else if (snippet === "html") out["HTML img tag"] = htmlSnippet(built.dataUrl);
  else out["Data URL"] = built.dataUrl;

  return out;
}

function decodeReport(text: string): Record<string, string> {
  const parsed = parseDataUrl(text);
  const format = sniffFormat(parsed.bytes);
  const out: Record<string, string> = {
    Direction: "Decoded from a data URL",
    "Media type": parsed.mediaType,
    Encoding: parsed.encoding === "base64" ? "base64" : "percent encoded",
    "Decoded size": formatBytes(parsed.bytes.length),
    "Data URL size": `${formatBytes(parsed.urlLength)} of text`,
    "Suggested filename": `image.${parsed.extension}`,
  };
  if (parsed.parameters.length > 0) out["Parameters"] = parsed.parameters.join("; ");
  if (format.mediaType !== parsed.mediaType && format !== UNKNOWN_FORMAT) {
    out["Actual bytes"] = `The payload looks like ${format.label}, not ${parsed.mediaType}.`;
  }
  out["Saving the file"] =
    "Use the download button in the panel above to write these bytes back out as a file.";
  return out;
}

export default { run } satisfies ToolLogic<
  Uint8Array | string,
  Record<string, string>,
  ImageToDataUrlOpts
>;
