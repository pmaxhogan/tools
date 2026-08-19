import { formatByteCount } from "@/lib/format";
import { ToolError, type ToolLogic } from "../types";

/**
 * The data core of the NFC Tag Reader and Writer.
 *
 * The panel owns the radio: only a real browser holds an NDEFReader/NDEFWriter
 * session, so requestPermission, scan(), write() and makeReadOnly() all live in
 * the Vue island. Everything that turns a record's meaning into NDEF bytes, and
 * back, lives here and stays pure, so the composed message the panel writes and
 * the reading it shows for a scanned tag can never disagree about what the bytes
 * mean.
 *
 * The tricky parts are the two lookup tables that trade byte width for meaning:
 * the URI RTD's prefix abbreviation table, and the Wi-Fi Simple Configuration
 * TLV layout nested inside a MIME record. Those are worth reading twice.
 */

/* ------------------------------------------------------------------ *
 * byte helpers
 * ------------------------------------------------------------------ */

function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function u16be(n: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, n, false);
  return out;
}

/** Uppercase, space separated hex, matching how a scanned tag's bytes are shown. */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

const HEX_FIX =
  'Use pairs of hex digits. Spaces, commas and 0x prefixes are fine, so "d1 01 08" and "D10108" are the same three bytes.';

/** Parse a loose hex string into bytes: separators and 0x prefixes optional. */
function parseHexBytes(text: string): Uint8Array {
  let cleaned = "";
  for (const token of text.split(/[\s,]+/)) {
    if (!token) continue;
    cleaned += token.replace(/^0x/i, "");
  }
  if (!/^[0-9a-fA-F]*$/.test(cleaned)) {
    throw new ToolError("bad-hex", "That is not a hex byte string.", HEX_FIX);
  }
  if (cleaned.length % 2 !== 0) {
    throw new ToolError(
      "bad-hex",
      `Hex input has ${cleaned.length} digits, which is an odd number, so the last byte is incomplete.`,
      HEX_FIX,
    );
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * NDEF record model
 * ------------------------------------------------------------------ */

/** NDEF Type Name Format, the 3-bit field that says how to read `type`. */
const TNF = {
  EMPTY: 0x00,
  WELL_KNOWN: 0x01,
  MIME_MEDIA: 0x02,
  ABSOLUTE_URI: 0x03,
  EXTERNAL: 0x04,
  UNKNOWN: 0x05,
  UNCHANGED: 0x06,
  RESERVED: 0x07,
} as const;

/**
 * One NDEF record at the byte level: a TNF, a type string (interpretation
 * depends on the TNF), an optional ID, and the raw payload bytes. This is the
 * shape `encodeMessage` writes and `decodeMessage`'s internal parser reads;
 * `buildRecord` produces one alongside its higher level representations.
 */
export interface NdefRecordObj {
  tnf: number;
  type: string;
  id?: string;
  payload: Uint8Array;
}

/** The NDEFRecordInit shape Web NFC's NDEFReader.write() expects. */
export interface WebNfcRecordInit {
  recordType: string;
  mediaType?: string;
  id?: string;
  data?: string | Uint8Array;
  encoding?: string;
  lang?: string;
}

/** The NDEFMessageInit shape Web NFC's NDEFReader.write() expects. */
export interface WebNfcMessageInit {
  records: WebNfcRecordInit[];
}

/** What `buildRecord` returns: the raw record plus both derived shapes. */
export interface BuiltRecord {
  record: NdefRecordObj;
  webNfc: WebNfcRecordInit;
  bytes: Uint8Array;
}

/* ------------------------------------------------------------------ *
 * decoded (semantic) record shapes
 * ------------------------------------------------------------------ */

export type DecodedRecord =
  | { kind: "text"; lang: string; encoding: "utf-8" | "utf-16"; text: string }
  | { kind: "url"; url: string }
  | { kind: "wifi"; ssid: string; key: string; auth: string }
  | { kind: "vcard"; name?: string; tel?: string; email?: string; url?: string; raw: string }
  | { kind: "geo"; lat: number; lon: number }
  | { kind: "mailto"; address: string }
  | { kind: "tel"; number: string }
  | { kind: "sms"; number: string; body?: string }
  | { kind: "app"; packageName: string }
  | { kind: "empty" }
  | { kind: "mime"; mediaType: string; bytes: Uint8Array }
  | { kind: "external"; type: string; bytes: Uint8Array }
  | { kind: "absolute-uri"; uri: string }
  | { kind: "unknown"; tnf: number; type: string; bytes: Uint8Array };

const KIND_DISPLAY: Record<DecodedRecord["kind"], string> = {
  text: "Text",
  url: "URL",
  wifi: "Wi-Fi",
  vcard: "vCard",
  geo: "Geo location",
  mailto: "Email",
  tel: "Phone",
  sms: "SMS",
  app: "Android app",
  empty: "Empty",
  mime: "MIME",
  external: "External",
  "absolute-uri": "Absolute URI",
  unknown: "Unknown",
};

/* ------------------------------------------------------------------ *
 * URI RTD prefix abbreviation table
 * ------------------------------------------------------------------ */

/**
 * The NFC Forum URI Record Type Definition's prefix abbreviation table.
 * Index is the one byte code stored at the start of a "U" record's payload;
 * the string is the literal prefix it stands in for. Index 0 means no
 * abbreviation, so the payload carries the whole URI.
 */
const URI_PREFIXES: string[] = [
  "",
  "http://www.",
  "https://www.",
  "http://",
  "https://",
  "tel:",
  "mailto:",
  "ftp://anonymous:anonymous@",
  "ftp://ftp.",
  "ftps://",
  "sftp://",
  "smb://",
  "nfs://",
  "ftp://",
  "dav://",
  "news:",
  "telnet://",
  "imap:",
  "rtsp://",
  "urn:",
  "pop:",
  "sip:",
  "sips:",
  "tftp:",
  "btspp://",
  "btl2cap://",
  "btgoep://",
  "tcpobex://",
  "irdaobex://",
  "file://",
  "urn:epc:id:",
  "urn:epc:tag:",
  "urn:epc:pat:",
  "urn:epc:raw:",
  "urn:epc:",
  "urn:nfc:",
];

/** Pick the longest matching prefix code for a URI, or 0 when none matches. */
function abbreviateUri(uri: string): { code: number; rest: string } {
  let bestCode = 0;
  let bestLen = 0;
  for (let code = 1; code < URI_PREFIXES.length; code++) {
    const prefix = URI_PREFIXES[code] ?? "";
    if (prefix.length > bestLen && uri.startsWith(prefix)) {
      bestCode = code;
      bestLen = prefix.length;
    }
  }
  return { code: bestCode, rest: uri.slice(bestLen) };
}

function expandUri(code: number, rest: string): string {
  return (URI_PREFIXES[code] ?? "") + rest;
}

/* ------------------------------------------------------------------ *
 * Wi-Fi Simple Configuration (WSC) TLVs
 * ------------------------------------------------------------------ */

const WIFI_MIME = "application/vnd.wfa.wsc";

const WSC = {
  CREDENTIAL: 0x100e,
  SSID: 0x1045,
  AUTH_TYPE: 0x1003,
  ENCRYPTION_TYPE: 0x100f,
  NETWORK_KEY: 0x1027,
  MAC_ADDRESS: 0x1020,
} as const;

const AUTH_TYPES: Record<string, { auth: number; enc: number }> = {
  OPEN: { auth: 0x0001, enc: 0x0001 },
  NONE: { auth: 0x0001, enc: 0x0001 },
  WEP: { auth: 0x0004, enc: 0x0002 },
  WPA: { auth: 0x0002, enc: 0x0004 },
  WPA2: { auth: 0x0020, enc: 0x0008 },
  "WPA/WPA2": { auth: 0x0022, enc: 0x0008 },
};

function authLabelFor(code: number): string {
  for (const [label, info] of Object.entries(AUTH_TYPES)) {
    if (info.auth === code) return label;
  }
  return `Unknown (0x${code.toString(16).padStart(4, "0")})`;
}

function tlv(id: number, value: Uint8Array): Uint8Array {
  return concatBytes([u16be(id), u16be(value.length), value]);
}

function encodeWscCredential(
  ssid: string,
  key: string,
  authInfo: { auth: number; enc: number },
): Uint8Array {
  const credentialValue = concatBytes([
    tlv(WSC.SSID, utf8Encode(ssid)),
    tlv(WSC.AUTH_TYPE, u16be(authInfo.auth)),
    tlv(WSC.ENCRYPTION_TYPE, u16be(authInfo.enc)),
    tlv(WSC.NETWORK_KEY, utf8Encode(key)),
    tlv(WSC.MAC_ADDRESS, Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff)),
  ]);
  return tlv(WSC.CREDENTIAL, credentialValue);
}

interface WscTlv {
  id: number;
  value: Uint8Array;
}

function parseTlvList(bytes: Uint8Array): WscTlv[] {
  const out: WscTlv[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const id = new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, false);
    const len = new DataView(bytes.buffer, bytes.byteOffset + offset + 2, 2).getUint16(0, false);
    offset += 4;
    if (offset + len > bytes.length) {
      throw new ToolError(
        "bad-ndef",
        "A Wi-Fi Simple Config TLV runs past the end of its container.",
        "The tag's Wi-Fi credential is malformed or truncated.",
      );
    }
    out.push({ id, value: bytes.slice(offset, offset + len) });
    offset += len;
  }
  return out;
}

function decodeWscCredential(payload: Uint8Array): { ssid: string; key: string; auth: string } {
  const top = parseTlvList(payload);
  const credential = top.find((t) => t.id === WSC.CREDENTIAL);
  if (!credential) {
    throw new ToolError(
      "bad-ndef",
      "The Wi-Fi record has no Credential attribute.",
      "This does not look like a Wi-Fi Simple Config token.",
    );
  }
  const inner = parseTlvList(credential.value);
  const ssidTlv = inner.find((t) => t.id === WSC.SSID);
  const keyTlv = inner.find((t) => t.id === WSC.NETWORK_KEY);
  const authTlv = inner.find((t) => t.id === WSC.AUTH_TYPE);
  if (!ssidTlv || !keyTlv) {
    throw new ToolError(
      "bad-ndef",
      "The Wi-Fi credential is missing its SSID or network key.",
      "This does not look like a complete Wi-Fi Simple Config token.",
    );
  }
  const ssid = new TextDecoder("utf-8").decode(ssidTlv.value);
  const key = new TextDecoder("utf-8").decode(keyTlv.value);
  const authCode = authTlv
    ? new DataView(authTlv.value.buffer, authTlv.value.byteOffset, authTlv.value.byteLength).getUint16(
        0,
        false,
      )
    : 0;
  return { ssid, key, auth: authLabelFor(authCode) };
}

/* ------------------------------------------------------------------ *
 * vCard
 * ------------------------------------------------------------------ */

const VCARD_MIME = "text/vcard";

function vcardField(lines: string[], key: string): string | undefined {
  const line = lines.find((l) => {
    const upper = l.toUpperCase();
    return upper.startsWith(`${key}:`) || upper.startsWith(`${key};`);
  });
  if (!line) return undefined;
  const idx = line.indexOf(":");
  return idx >= 0 ? line.slice(idx + 1).trim() : undefined;
}

function parseVCard(text: string): { name?: string; tel?: string; email?: string; url?: string } {
  const lines = text.split(/\r\n|\n|\r/);
  const name = vcardField(lines, "FN") ?? vcardField(lines, "N");
  return {
    name,
    tel: vcardField(lines, "TEL"),
    email: vcardField(lines, "EMAIL"),
    url: vcardField(lines, "URL"),
  };
}

/* ------------------------------------------------------------------ *
 * Android Application Record
 * ------------------------------------------------------------------ */

const AAR_TYPE = "android.com:pkg";

/* ------------------------------------------------------------------ *
 * text and URL payload codecs (shared by build, decode, and Web NFC derive)
 * ------------------------------------------------------------------ */

function encodeTextPayload(text: string, lang: string): Uint8Array {
  const langBytes = utf8Encode(lang);
  const status = langBytes.length & 0x3f; // top bit clear: UTF-8
  return concatBytes([Uint8Array.of(status), langBytes, utf8Encode(text)]);
}

function decodeTextPayload(payload: Uint8Array): { lang: string; encoding: "utf-8" | "utf-16"; text: string } {
  if (payload.length === 0) {
    throw new ToolError(
      "bad-ndef",
      "A text record has an empty payload; it needs at least a status byte.",
      "The tag's text record is truncated.",
    );
  }
  const status = payload[0] as number;
  const isUtf16 = (status & 0x80) !== 0;
  const langLength = status & 0x3f;
  if (1 + langLength > payload.length) {
    throw new ToolError(
      "bad-ndef",
      "A text record's language code runs past its payload.",
      "The tag's text record is truncated or the status byte is wrong.",
    );
  }
  const lang = new TextDecoder("ascii").decode(payload.slice(1, 1 + langLength));
  const textBytes = payload.slice(1 + langLength);
  const encoding: "utf-8" | "utf-16" = isUtf16 ? "utf-16" : "utf-8";
  const text = new TextDecoder(isUtf16 ? "utf-16le" : "utf-8").decode(textBytes);
  return { lang, encoding, text };
}

function decodeUrlRaw(payload: Uint8Array): string {
  if (payload.length === 0) {
    throw new ToolError(
      "bad-ndef",
      "A URL record has an empty payload; it needs at least a prefix code byte.",
      "The tag's URL record is truncated.",
    );
  }
  const code = payload[0] as number;
  const rest = new TextDecoder("utf-8").decode(payload.slice(1));
  return expandUri(code, rest);
}

/* ------------------------------------------------------------------ *
 * message level encode / decode
 * ------------------------------------------------------------------ */

function encodeRecord(record: NdefRecordObj, mb: boolean, me: boolean): Uint8Array {
  const typeBytes = utf8Encode(record.type);
  const payload = record.payload;
  const sr = payload.length <= 0xff;
  let header = record.tnf & 0x07;
  if (mb) header |= 0x80;
  if (me) header |= 0x40;
  if (sr) header |= 0x10;

  const parts: Uint8Array[] = [Uint8Array.of(header), Uint8Array.of(typeBytes.length)];
  if (sr) {
    parts.push(Uint8Array.of(payload.length));
  } else {
    const lenBytes = new Uint8Array(4);
    new DataView(lenBytes.buffer).setUint32(0, payload.length, false);
    parts.push(lenBytes);
  }
  parts.push(typeBytes, payload);
  return concatBytes(parts);
}

/**
 * Encode a list of records into one NDEF message: MB set on the first record,
 * ME on the last, SR whenever a record's payload fits in one length byte.
 * Chunking (the CF flag) is never produced.
 */
export function encodeMessage(records: NdefRecordObj[]): Uint8Array {
  if (records.length === 0) return new Uint8Array(0);
  return concatBytes(
    records.map((record, i) => encodeRecord(record, i === 0, i === records.length - 1)),
  );
}

/** Parse the raw NDEF record structure: flags, TNF, type, id and payload. */
function parseRawRecords(bytes: Uint8Array): NdefRecordObj[] {
  const records: NdefRecordObj[] = [];
  let offset = 0;
  let sawFirst = false;
  let sawLast = false;

  while (offset < bytes.length) {
    if (sawLast) {
      throw new ToolError(
        "bad-ndef",
        "Bytes remain after a record with the message end (ME) flag.",
        "This looks like more than one NDEF message concatenated together.",
      );
    }

    const header = bytes[offset];
    if (header === undefined) {
      throw new ToolError(
        "bad-ndef",
        "Unexpected end of data while reading a record header.",
        "The byte stream is truncated.",
      );
    }
    offset += 1;

    const mb = (header & 0x80) !== 0;
    const me = (header & 0x40) !== 0;
    const cf = (header & 0x20) !== 0;
    const sr = (header & 0x10) !== 0;
    const il = (header & 0x08) !== 0;
    const tnf = header & 0x07;

    if (!sawFirst) {
      if (!mb) {
        throw new ToolError(
          "bad-ndef",
          "The first record is missing the message begin (MB) flag.",
          "This does not look like the start of a complete NDEF message.",
        );
      }
      sawFirst = true;
    } else if (mb) {
      throw new ToolError(
        "bad-ndef",
        "A record after the first has the message begin (MB) flag set.",
        "Only the first record of a message may set MB.",
      );
    }

    if (cf) {
      throw new ToolError(
        "bad-ndef",
        "Chunked NDEF records are not supported.",
        "Re-export the tag content as a single, unchunked record.",
      );
    }
    if (tnf === TNF.UNCHANGED || tnf === TNF.RESERVED) {
      throw new ToolError(
        "bad-ndef",
        `TNF ${tnf} is reserved or requires a preceding chunk, which is not supported.`,
        "This byte stream is not a complete, unchunked NDEF message.",
      );
    }

    const typeLength = bytes[offset];
    if (typeLength === undefined) {
      throw new ToolError(
        "bad-ndef",
        "Unexpected end of data while reading the type length.",
        "The byte stream is truncated.",
      );
    }
    offset += 1;

    let payloadLength: number;
    if (sr) {
      const b = bytes[offset];
      if (b === undefined) {
        throw new ToolError(
          "bad-ndef",
          "Unexpected end of data while reading the payload length.",
          "The byte stream is truncated.",
        );
      }
      payloadLength = b;
      offset += 1;
    } else {
      if (offset + 4 > bytes.length) {
        throw new ToolError(
          "bad-ndef",
          "Unexpected end of data while reading the payload length.",
          "The byte stream is truncated.",
        );
      }
      payloadLength = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
      offset += 4;
    }

    let idLength = 0;
    if (il) {
      const b = bytes[offset];
      if (b === undefined) {
        throw new ToolError(
          "bad-ndef",
          "Unexpected end of data while reading the ID length.",
          "The byte stream is truncated.",
        );
      }
      idLength = b;
      offset += 1;
    }

    if (offset + typeLength > bytes.length) {
      throw new ToolError(
        "bad-ndef",
        "The type field runs past the end of the data.",
        "The byte stream is truncated or a length header is wrong.",
      );
    }
    const type = new TextDecoder("utf-8").decode(bytes.slice(offset, offset + typeLength));
    offset += typeLength;

    let id: string | undefined;
    if (il) {
      if (offset + idLength > bytes.length) {
        throw new ToolError(
          "bad-ndef",
          "The ID field runs past the end of the data.",
          "The byte stream is truncated or a length header is wrong.",
        );
      }
      id = new TextDecoder("utf-8").decode(bytes.slice(offset, offset + idLength));
      offset += idLength;
    }

    if (offset + payloadLength > bytes.length) {
      throw new ToolError(
        "bad-ndef",
        "The payload runs past the end of the data.",
        "The byte stream is truncated or the payload length header is wrong.",
      );
    }
    const payload = bytes.slice(offset, offset + payloadLength);
    offset += payloadLength;

    records.push(id === undefined ? { tnf, type, payload } : { tnf, type, id, payload });
    if (me) sawLast = true;
  }

  if (!sawFirst || !sawLast) {
    throw new ToolError(
      "bad-ndef",
      "The data never reaches a record with the message end (ME) flag.",
      "This does not look like a complete NDEF message.",
    );
  }
  return records;
}

/** Turn one raw record into its semantic, display-ready decoded form. */
function decodeSemantic(record: NdefRecordObj): DecodedRecord {
  switch (record.tnf) {
    case TNF.EMPTY:
      return { kind: "empty" };
    case TNF.WELL_KNOWN: {
      if (record.type === "T") {
        const { lang, encoding, text } = decodeTextPayload(record.payload);
        return { kind: "text", lang, encoding, text };
      }
      if (record.type === "U") {
        const uri = decodeUrlRaw(record.payload);
        if (uri.startsWith("geo:")) {
          const m = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(uri);
          if (m) return { kind: "geo", lat: Number(m[1]), lon: Number(m[2]) };
        }
        if (uri.startsWith("mailto:")) return { kind: "mailto", address: uri.slice("mailto:".length) };
        if (uri.startsWith("tel:")) return { kind: "tel", number: uri.slice("tel:".length) };
        if (uri.startsWith("sms:")) {
          const withoutScheme = uri.slice("sms:".length);
          const [number, query] = withoutScheme.split("?");
          const body = query?.startsWith("body=") ? decodeURIComponent(query.slice(5)) : undefined;
          return body === undefined
            ? { kind: "sms", number: number ?? "" }
            : { kind: "sms", number: number ?? "", body };
        }
        return { kind: "url", url: uri };
      }
      return { kind: "unknown", tnf: record.tnf, type: record.type, bytes: record.payload };
    }
    case TNF.MIME_MEDIA: {
      if (record.type === WIFI_MIME) {
        const { ssid, key, auth } = decodeWscCredential(record.payload);
        return { kind: "wifi", ssid, key, auth };
      }
      if (record.type === VCARD_MIME || record.type === "text/x-vcard") {
        const text = new TextDecoder("utf-8").decode(record.payload);
        return { kind: "vcard", ...parseVCard(text), raw: text };
      }
      return { kind: "mime", mediaType: record.type, bytes: record.payload };
    }
    case TNF.ABSOLUTE_URI:
      return { kind: "absolute-uri", uri: new TextDecoder("utf-8").decode(record.payload) };
    case TNF.EXTERNAL:
      if (record.type === AAR_TYPE) {
        return { kind: "app", packageName: new TextDecoder("utf-8").decode(record.payload) };
      }
      return { kind: "external", type: record.type, bytes: record.payload };
    default:
      return { kind: "unknown", tnf: record.tnf, type: record.type, bytes: record.payload };
  }
}

/**
 * Parse NDEF message bytes into fully decoded records: text language and
 * encoding, the URL prefix table expanded back to a full URI (and further
 * classified into geo, tel, mailto and sms when the URI scheme says so), the
 * Wi-Fi Simple Config TLVs resolved to SSID, key and auth, and vCard fields.
 * Throws `bad-ndef` with a specific reason for anything malformed.
 */
export function decodeMessage(bytes: Uint8Array): DecodedRecord[] {
  return parseRawRecords(bytes).map(decodeSemantic);
}

/* ------------------------------------------------------------------ *
 * Web NFC derivation
 * ------------------------------------------------------------------ */

/** Convert one raw record into the NDEFRecordInit shape NDEFReader.write() takes. */
function deriveWebNfc(record: NdefRecordObj): WebNfcRecordInit {
  if (record.tnf === TNF.EMPTY) return { recordType: "empty" };
  if (record.tnf === TNF.WELL_KNOWN && record.type === "T") {
    const { lang, encoding, text } = decodeTextPayload(record.payload);
    return { recordType: "text", data: text, lang, encoding };
  }
  if (record.tnf === TNF.WELL_KNOWN && record.type === "U") {
    return { recordType: "url", data: decodeUrlRaw(record.payload) };
  }
  if (record.tnf === TNF.MIME_MEDIA) {
    return { recordType: "mime", mediaType: record.type, data: record.payload };
  }
  if (record.tnf === TNF.EXTERNAL) {
    return { recordType: record.type, data: record.payload };
  }
  if (record.tnf === TNF.ABSOLUTE_URI) {
    return { recordType: "absolute-url", data: new TextDecoder("utf-8").decode(record.payload) };
  }
  return { recordType: "unknown", data: record.payload };
}

/** Build the NDEFMessageInit shape for NDEFReader.write() from raw records. */
export function toWebNfcMessage(records: NdefRecordObj[]): WebNfcMessageInit {
  return { records: records.map(deriveWebNfc) };
}

/* ------------------------------------------------------------------ *
 * describeRecords: display strings for decoded records
 * ------------------------------------------------------------------ */

function describeOne(r: DecodedRecord): string {
  switch (r.kind) {
    case "text":
      return `${r.text} [${r.lang}, ${r.encoding}]`;
    case "url":
      return r.url;
    case "wifi":
      return `SSID "${r.ssid}", key "${r.key}", auth ${r.auth}`;
    case "vcard": {
      const parts = [
        r.name && `Name: ${r.name}`,
        r.tel && `Tel: ${r.tel}`,
        r.email && `Email: ${r.email}`,
        r.url && `URL: ${r.url}`,
      ].filter((p): p is string => Boolean(p));
      return parts.length ? parts.join(", ") : "(empty vCard)";
    }
    case "geo":
      return `${r.lat}, ${r.lon}`;
    case "mailto":
      return r.address;
    case "tel":
      return r.number;
    case "sms":
      return r.body ? `${r.number}: ${r.body}` : r.number;
    case "app":
      return r.packageName;
    case "empty":
      return "(empty record)";
    case "mime":
      return `${r.mediaType}, ${r.bytes.length} bytes`;
    case "external":
      return `${r.type}, ${r.bytes.length} bytes`;
    case "absolute-uri":
      return r.uri;
    case "unknown":
      return `TNF ${r.tnf} type "${r.type}", ${r.bytes.length} bytes`;
  }
}

/** Render decoded records as labeled, copyable display rows. */
export function describeRecords(records: DecodedRecord[]): Record<string, string> {
  const out: Record<string, string> = {};
  records.forEach((r, i) => {
    out[`Record ${i + 1} (${KIND_DISPLAY[r.kind]})`] = describeOne(r);
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * tag capacity
 * ------------------------------------------------------------------ */

/** Usable NDEF payload capacity, in bytes, of common NFC tag chips. */
export const TAG_CAPACITIES: Record<string, number> = {
  NTAG213: 144,
  NTAG215: 504,
  NTAG216: 888,
  "Mifare Ultralight": 48,
  "Topaz 512": 96,
};

export interface CapacityFit {
  tagType: string;
  capacityBytes: number;
  fits: boolean;
  verdict: string;
}

/** Whether a message of `messageBytes` bytes fits on the named tag type. */
export function tagCapacityFit(messageBytes: number, tagType: string): CapacityFit {
  const capacity = TAG_CAPACITIES[tagType];
  if (capacity === undefined) {
    return { tagType, capacityBytes: 0, fits: false, verdict: `Unknown tag type "${tagType}".` };
  }
  const fits = messageBytes <= capacity;
  const verdict = fits
    ? `Fits on ${tagType} (${capacity} B usable, message is ${messageBytes} B).`
    : `Does not fit on ${tagType}: message is ${messageBytes} B but only ${capacity} B is usable.`;
  return { tagType, capacityBytes: capacity, fits, verdict };
}

function fitsOnLabel(messageBytes: number): string {
  const fitting = Object.keys(TAG_CAPACITIES).filter(
    (tagType) => tagCapacityFit(messageBytes, tagType).fits,
  );
  return fitting.length ? fitting.join(", ") : `none of the common tags (message is ${messageBytes} B)`;
}

/* ------------------------------------------------------------------ *
 * buildRecord: kind + value -> a full NDEF record, three ways
 * ------------------------------------------------------------------ */

function finalize(record: NdefRecordObj): BuiltRecord {
  return { record, webNfc: deriveWebNfc(record), bytes: encodeMessage([record]) };
}

function isValidUrl(candidate: string): boolean {
  try {
    new URL(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Validate a URL, trying an https:// prefix for a bare domain before failing. */
function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (isValidUrl(trimmed)) return trimmed;
  const withScheme = `https://${trimmed}`;
  if (isValidUrl(withScheme)) return withScheme;
  throw new ToolError(
    "bad-url",
    `"${value}" is not a valid URL.`,
    "Include a scheme like https:// or enter a bare domain such as example.com.",
  );
}

function buildUriWellKnown(uri: string): BuiltRecord {
  const { code, rest } = abbreviateUri(uri);
  const payload = concatBytes([Uint8Array.of(code), utf8Encode(rest)]);
  return finalize({ tnf: TNF.WELL_KNOWN, type: "U", payload });
}

function buildTextRecord(value: string): BuiltRecord {
  const payload = encodeTextPayload(value, "en");
  return finalize({ tnf: TNF.WELL_KNOWN, type: "T", payload });
}

function buildUrlRecord(value: string): BuiltRecord {
  return buildUriWellKnown(normalizeUrl(value));
}

function buildWifiRecord(value: string): BuiltRecord {
  const parts = value.split(";").map((p) => p.trim());
  const ssid = parts[0] ?? "";
  const key = parts[1] ?? "";
  const authLabel = (parts[2] || "WPA2").toUpperCase();
  if (!ssid || !key) {
    throw new ToolError(
      "bad-wifi",
      "A Wi-Fi record needs both a network name and a password.",
      'Use the format "ssid;password;WPA2" (the auth type is optional and defaults to WPA2).',
    );
  }
  const authInfo = AUTH_TYPES[authLabel];
  if (!authInfo) {
    throw new ToolError(
      "bad-wifi",
      `"${parts[2]}" is not a recognized Wi-Fi security type.`,
      "Use one of: Open, WEP, WPA, WPA2, WPA/WPA2.",
    );
  }
  const payload = encodeWscCredential(ssid, key, authInfo);
  return finalize({ tnf: TNF.MIME_MEDIA, type: WIFI_MIME, payload });
}

function buildVCardRecord(value: string): BuiltRecord {
  const parts = value.split(";").map((p) => p.trim());
  const [name = "", tel = "", email = "", url = ""] = parts;
  const lines = ["BEGIN:VCARD", "VERSION:3.0"];
  if (name) {
    lines.push(`N:${name}`, `FN:${name}`);
  }
  if (tel) lines.push(`TEL:${tel}`);
  if (email) lines.push(`EMAIL:${email}`);
  if (url) lines.push(`URL:${url}`);
  lines.push("END:VCARD");
  const payload = utf8Encode(lines.join("\r\n"));
  return finalize({ tnf: TNF.MIME_MEDIA, type: VCARD_MIME, payload });
}

function buildGeoRecord(value: string): BuiltRecord {
  const match = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) {
    throw new ToolError(
      "bad-url",
      `"${value}" is not a valid "lat,lon" pair.`,
      'Use decimal degrees like "37.7749,-122.4194".',
    );
  }
  return buildUriWellKnown(`geo:${match[1]},${match[2]}`);
}

function buildTelRecord(value: string): BuiltRecord {
  const trimmed = value.trim();
  if (!/\d/.test(trimmed)) {
    throw new ToolError(
      "bad-url",
      `"${value}" does not look like a phone number.`,
      "Include the number, digits only or with + and separators.",
    );
  }
  const uri = trimmed.startsWith("tel:") ? trimmed : `tel:${trimmed}`;
  return buildUriWellKnown(uri);
}

function buildMailtoRecord(value: string): BuiltRecord {
  const trimmed = value.trim();
  const address = trimmed.replace(/^mailto:/i, "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new ToolError(
      "bad-url",
      `"${value}" is not a valid email address.`,
      "Use an address like name@example.com.",
    );
  }
  return buildUriWellKnown(`mailto:${address}`);
}

function buildSmsRecord(value: string): BuiltRecord {
  const parts = value.split(";").map((p) => p.trim());
  const number = parts[0] ?? "";
  const body = parts[1];
  if (!/\d/.test(number)) {
    throw new ToolError(
      "bad-url",
      `"${value}" does not look like a phone number.`,
      'Use the format "number" or "number;message body".',
    );
  }
  const uri = body ? `sms:${number}?body=${encodeURIComponent(body)}` : `sms:${number}`;
  return buildUriWellKnown(uri);
}

function buildAppRecord(value: string): BuiltRecord {
  const payload = utf8Encode(value.trim());
  return finalize({ tnf: TNF.EXTERNAL, type: AAR_TYPE, payload });
}

function buildEmptyRecord(): BuiltRecord {
  return finalize({ tnf: TNF.EMPTY, type: "", payload: new Uint8Array(0) });
}

/**
 * Build one NDEF record for a kind and value. Returns the raw record (for
 * composing into a multi-record message with `encodeMessage`), the Web NFC
 * NDEFRecordInit shape, and the record's complete single-record NDEF bytes.
 */
export function buildRecord(kind: string, value: string): BuiltRecord {
  switch (kind) {
    case "text":
      return buildTextRecord(value);
    case "url":
      return buildUrlRecord(value);
    case "wifi":
      return buildWifiRecord(value);
    case "vcard":
      return buildVCardRecord(value);
    case "geo":
      return buildGeoRecord(value);
    case "tel":
      return buildTelRecord(value);
    case "mailto":
      return buildMailtoRecord(value);
    case "sms":
      return buildSmsRecord(value);
    case "app":
      return buildAppRecord(value);
    case "empty":
      return buildEmptyRecord();
    default:
      return buildTextRecord(value);
  }
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

export interface NfcTagOpts {
  kind?: string;
}

const KIND_SYNONYMS: Record<string, string[]> = {
  text: ["text", "plain text", "note", "message"],
  url: ["url", "website", "link", "web address", "webpage"],
  wifi: ["wifi", "wi-fi", "wifi password", "network", "wpa2"],
  vcard: ["vcard", "contact", "business card", "contact card"],
  geo: ["geo", "location", "coordinates", "gps", "lat lon"],
  tel: ["tel", "phone", "call", "phone number"],
  mailto: ["mailto", "email", "e-mail"],
  sms: ["sms", "text message", "sms message"],
  app: ["app", "android", "android app", "package", "aar"],
  empty: ["empty", "blank", "erase", "clear", "lock"],
  "raw-hex-decode": ["raw-hex-decode", "decode", "parse", "hex", "read", "scan"],
};

const KIND_LABELS: Record<string, string> = {
  text: "Text",
  url: "URL",
  wifi: "Wi-Fi credential",
  vcard: "vCard contact",
  geo: "Geo location",
  tel: "Phone number",
  mailto: "Email address",
  sms: "SMS",
  app: "Android app (AAR)",
  empty: "Empty",
};

function normalizeKind(input?: string): string {
  const raw = (input ?? "text").trim().toLowerCase();
  if (!raw) return "text";
  for (const [kind, synonyms] of Object.entries(KIND_SYNONYMS)) {
    if (kind === raw || synonyms.includes(raw)) return kind;
  }
  return raw in KIND_LABELS || raw === "raw-hex-decode" ? raw : "text";
}

/** Common NFC message ceiling for this tool: well above any real tag's capacity. */
const MAX_MESSAGE_BYTES = 8192;

function payloadPreview(record: NdefRecordObj): string {
  return describeOne(decodeSemantic(record));
}

function runBuild(kind: string, input: string): Record<string, string> {
  const trimmed = input.trim();
  if (kind !== "empty" && trimmed.length === 0) {
    throw new ToolError(
      "empty-input",
      "Enter a value to encode.",
      "Type the text, URL, or other value for the selected record kind.",
    );
  }

  const built = buildRecord(kind, trimmed);
  if (built.bytes.length > MAX_MESSAGE_BYTES) {
    throw new ToolError(
      "too-large",
      `The encoded NDEF message is ${built.bytes.length} bytes, over the 8 KB limit.`,
      "Shorten the input. Common NFC tags top out well below this size.",
    );
  }

  return {
    "Record type": KIND_LABELS[kind] ?? kind,
    "Payload preview": payloadPreview(built.record),
    "NDEF bytes (hex)": bytesToHex(built.bytes),
    Size: formatByteCount(built.bytes.length),
    "Fits on": fitsOnLabel(built.bytes.length),
  };
}

function runDecode(input: string): Record<string, string> {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new ToolError(
      "empty-input",
      "Paste the hex bytes of an NDEF message to decode.",
      'Copy the bytes read from a tag, such as "D1 01 08 54 02 65 6E 68 65 6C 6C 6F".',
    );
  }
  const bytes = parseHexBytes(trimmed);
  if (bytes.length === 0) {
    throw new ToolError(
      "empty-input",
      "Paste the hex bytes of an NDEF message to decode.",
      'Copy the bytes read from a tag, such as "D1 01 08 54 02 65 6E 68 65 6C 6C 6F".',
    );
  }
  if (bytes.length > MAX_MESSAGE_BYTES) {
    throw new ToolError(
      "too-large",
      `The input is ${bytes.length} bytes, over the 8 KB limit.`,
      "Paste a smaller NDEF message.",
    );
  }

  const decoded = decodeMessage(bytes);
  return {
    "Records decoded": String(decoded.length),
    ...describeRecords(decoded),
    "NDEF bytes (hex)": bytesToHex(bytes),
    Size: formatByteCount(bytes.length),
    "Fits on": fitsOnLabel(bytes.length),
  };
}

/**
 * Build an NDEF record from a kind and value, or decode a hex-pasted NDEF
 * message back into readable rows when `opts.kind` is "raw-hex-decode".
 */
export function run(input: string = "", opts: NfcTagOpts = {}): Record<string, string> {
  const kind = normalizeKind(opts.kind);
  return kind === "raw-hex-decode" ? runDecode(input) : runBuild(kind, input);
}

export default { run } satisfies ToolLogic<string, Record<string, string>, NfcTagOpts>;
