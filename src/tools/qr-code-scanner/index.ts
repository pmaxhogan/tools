import jsQR from "jsqr";
import { ToolError, type ToolLogic } from "../types";

/**
 * A raw image buffer, shaped like the browser's ImageData: a flat RGBA byte
 * array plus its pixel dimensions. The panel grabs this from a canvas (a live
 * camera frame or a decoded image file) and hands it straight to `decodeQr`,
 * so this layer never touches a canvas, a video element, or the DOM.
 */
export interface ImageInput {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface QrOpts {
  /**
   * How jsQR handles dark-on-light versus light-on-dark codes. 'attemptBoth'
   * catches inverted codes at the cost of a second pass; 'dontInvert' is the
   * fast path for a live camera feed.
   */
  inversion: "attemptBoth" | "dontInvert" | "onlyInvert" | "invertFirst";
  [key: string]: unknown;
}

/** The recognized payload shapes. Anything unmatched falls back to 'text'. */
export type QrKind =
  "url" | "wifi" | "geo" | "email" | "phone" | "sms" | "vcard" | "event" | "text";

/** One labeled row of a structured interpretation. */
export interface DecodedField {
  label: string;
  value: string;
}

export interface DecodeResult {
  /** The exact text encoded in the code, untouched. */
  text: string;
  /** Which payload shape was recognized. */
  kind: QrKind;
  /** Human label for the shape, e.g. "Web link". No trailing punctuation. */
  label: string;
  /** Structured breakdown when the shape is understood. Omitted for plain text. */
  fields?: DecodedField[];
  /**
   * A safe, clickable target when the payload is a link the panel may render as
   * an anchor: only http(s), mailto and tel. Never set for javascript:, data:,
   * or any other scheme, so the panel can render it without an allowlist of its
   * own. Absent means "render as inert text".
   */
  url?: string;
}

/* -------------------------------------------------------------------------- */
/* Escape-aware splitting (shared by the WIFI and iCalendar/vCard grammars)    */
/* -------------------------------------------------------------------------- */

/**
 * Split on an unescaped delimiter, keeping the backslash escape sequences
 * intact so the caller can unescape each piece afterwards. A backslash escapes
 * the next character, so `\;` is never treated as a separator.
 */
function splitUnescaped(input: string, delim: string): string[] {
  const out: string[] = [];
  let current = "";
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (c === "\\" && i + 1 < input.length) {
      current += c + input[i + 1]!;
      i++;
    } else if (c === delim) {
      out.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  out.push(current);
  return out;
}

/** Undo a single-character backslash escape: `\;` becomes `;`, `\\` becomes `\`. */
function unescapeSimple(value: string): string {
  return value.replace(/\\(.)/g, "$1");
}

/**
 * Unescape an iCalendar / vCard TEXT value (RFC 5545, RFC 6350): the literal
 * two-character sequence \n (or \N) is a newline; backslash, comma and
 * semicolon are self-escaped.
 */
function unescapeIcalText(value: string): string {
  return value.replace(/\\([nN\\,;])/g, (_, ch: string) => (ch === "n" || ch === "N" ? "\n" : ch));
}

/* -------------------------------------------------------------------------- */
/* Payload interpreters                                                        */
/* -------------------------------------------------------------------------- */

/** Parse a WIFI: join payload into readable fields. */
function interpretWifi(text: string): DecodeResult {
  // Drop the scheme and the trailing ";;" terminator if present.
  const body = text.slice(5).replace(/;;\s*$/, "");
  const parsed: Record<string, string> = {};
  for (const segment of splitUnescaped(body, ";")) {
    if (!segment) continue;
    const [key = "", ...rest] = splitUnescaped(segment, ":");
    parsed[key.toUpperCase()] = unescapeSimple(rest.join(":"));
  }

  const security = (parsed.T ?? "").trim();
  const fields: DecodedField[] = [{ label: "Network name", value: parsed.S ?? "" }];
  if (parsed.P) fields.push({ label: "Password", value: parsed.P });
  fields.push({
    label: "Security",
    value: !security || /^nopass$/i.test(security) ? "Open (no password)" : security.toUpperCase(),
  });
  if (/^(true|yes|1)$/i.test((parsed.H ?? "").trim()))
    fields.push({ label: "Hidden network", value: "Yes" });

  return { text, kind: "wifi", label: "Wi-Fi network", fields };
}

/** Parse a geo: URI (RFC 5870) into latitude and longitude. */
function interpretGeo(text: string): DecodeResult {
  const body = text.slice(4).split(";")[0] ?? "";
  const [lat = "", lng = "", alt] = body.split(",");
  const fields: DecodedField[] = [
    { label: "Latitude", value: lat.trim() },
    { label: "Longitude", value: lng.trim() },
  ];
  if (alt !== undefined && alt.trim()) fields.push({ label: "Altitude", value: alt.trim() });
  return { text, kind: "geo", label: "Map location", fields };
}

/** Parse a mailto: URL into recipient, subject and body. */
function interpretEmail(text: string): DecodeResult {
  const fields: DecodedField[] = [];
  try {
    const url = new URL(text);
    const to = decodeURIComponent(url.pathname);
    if (to) fields.push({ label: "To", value: to });
    const subject = url.searchParams.get("subject");
    if (subject) fields.push({ label: "Subject", value: subject });
    const body = url.searchParams.get("body");
    if (body) fields.push({ label: "Message", value: body });
  } catch {
    fields.push({ label: "To", value: text.slice(7) });
  }
  return { text, kind: "email", label: "Email message", fields, url: text };
}

/** Parse a tel: URL into a dialable number. */
function interpretPhone(text: string): DecodeResult {
  return {
    text,
    kind: "phone",
    label: "Phone number",
    fields: [{ label: "Number", value: text.slice(4) }],
    url: text,
  };
}

/** Parse an SMSTO: or sms: payload into a number and an optional message. */
function interpretSms(text: string): DecodeResult {
  const fields: DecodedField[] = [];
  if (/^smsto:/i.test(text)) {
    const rest = text.slice(6);
    const idx = rest.indexOf(":");
    const number = idx === -1 ? rest : rest.slice(0, idx);
    const message = idx === -1 ? "" : rest.slice(idx + 1);
    fields.push({ label: "Number", value: number });
    if (message) fields.push({ label: "Message", value: message });
  } else {
    // sms:number or sms:number?body=...
    const rest = text.slice(4);
    const [numberPart = "", query = ""] = rest.split("?");
    const number = numberPart.split(":")[0] ?? numberPart;
    fields.push({ label: "Number", value: number });
    const params = new URLSearchParams(query);
    const body = params.get("body");
    if (body) fields.push({ label: "Message", value: body });
  }
  return { text, kind: "sms", label: "Text message", fields };
}

/**
 * Unfold folded content lines (RFC 5545 section 3.1): a line that begins with a
 * space or tab is a continuation of the previous line.
 */
function unfold(text: string): string[] {
  const raw = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Split "PROP;PARAM=x:value" into its property name and raw value. */
function splitProperty(line: string): { name: string; value: string } {
  const colon = line.indexOf(":");
  if (colon === -1) return { name: line.toUpperCase(), value: "" };
  const head = line.slice(0, colon);
  const name = (head.split(";")[0] ?? head).toUpperCase();
  return { name, value: line.slice(colon + 1) };
}

/** Parse a vCard contact card into name, contact details and organization. */
function interpretVcard(text: string): DecodeResult {
  const props = new Map<string, string>();
  for (const line of unfold(text)) {
    const { name, value } = splitProperty(line);
    if (!props.has(name) && value) props.set(name, value);
  }

  const fields: DecodedField[] = [];
  const push = (label: string, key: string) => {
    const value = props.get(key);
    if (value) fields.push({ label, value: unescapeIcalText(value) });
  };

  let displayName = props.get("FN");
  if (!displayName && props.get("N")) {
    // N is Family;Given;Additional;Prefix;Suffix.
    const parts = splitUnescaped(props.get("N")!, ";").map(unescapeSimple);
    displayName = [parts[3], parts[1], parts[2], parts[0], parts[4]]
      .filter((p) => p && p.trim())
      .join(" ")
      .trim();
  }
  if (displayName) fields.push({ label: "Name", value: unescapeIcalText(displayName) });
  push("Organization", "ORG");
  push("Job title", "TITLE");
  // TEL and EMAIL carry type parameters, so they are matched by prefix.
  for (const [key, value] of props) {
    if (key.startsWith("TEL")) {
      fields.push({ label: "Phone", value: unescapeIcalText(value) });
      break;
    }
  }
  for (const [key, value] of props) {
    if (key.startsWith("EMAIL")) {
      fields.push({ label: "Email", value: unescapeIcalText(value) });
      break;
    }
  }
  push("Website", "URL");
  for (const [key, value] of props) {
    if (key.startsWith("ADR")) {
      const parts = splitUnescaped(value, ";").map((p) => unescapeIcalText(unescapeSimple(p)));
      const address = parts.filter((p) => p.trim()).join(", ");
      if (address) fields.push({ label: "Address", value: address });
      break;
    }
  }
  push("Note", "NOTE");

  return { text, kind: "vcard", label: "Contact card", fields };
}

/** Format an iCalendar basic timestamp (20260806T090000Z) for display. */
function formatIcalDate(value: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/.exec(value.trim());
  if (!m) return value;
  const [, y, mo, d, hh, mm, ss, z] = m;
  let out = `${y}-${mo}-${d}`;
  if (hh) out += ` ${hh}:${mm}${ss ? `:${ss}` : ""}${z ? " UTC" : ""}`;
  return out;
}

/** Parse a VEVENT (inside a VCALENDAR or bare) into its summary, times and place. */
function interpretEvent(text: string): DecodeResult {
  const props = new Map<string, string>();
  for (const line of unfold(text)) {
    const { name, value } = splitProperty(line);
    if (!props.has(name) && value) props.set(name, value);
  }

  const fields: DecodedField[] = [];
  const summary = props.get("SUMMARY");
  if (summary) fields.push({ label: "Title", value: unescapeIcalText(summary) });
  const start = props.get("DTSTART");
  if (start) fields.push({ label: "Starts", value: formatIcalDate(start) });
  const end = props.get("DTEND");
  if (end) fields.push({ label: "Ends", value: formatIcalDate(end) });
  const location = props.get("LOCATION");
  if (location) fields.push({ label: "Location", value: unescapeIcalText(location) });
  const description = props.get("DESCRIPTION");
  if (description) fields.push({ label: "Description", value: unescapeIcalText(description) });

  return { text, kind: "event", label: "Calendar event", fields };
}

/**
 * Classify a decoded string and, where the shape is understood, break it into
 * labeled fields. Pure and side-effect free, so the panel and the tests can
 * call it directly with any string.
 */
export function interpret(text: string): DecodeResult {
  const trimmed = text.trim();

  if (/^WIFI:/i.test(trimmed)) return interpretWifi(trimmed);
  if (/^geo:/i.test(trimmed)) return interpretGeo(trimmed);
  if (/^mailto:/i.test(trimmed)) return interpretEmail(trimmed);
  if (/^tel:/i.test(trimmed)) return interpretPhone(trimmed);
  if (/^(smsto:|sms:)/i.test(trimmed)) return interpretSms(trimmed);
  if (/^BEGIN:VCARD/i.test(trimmed)) return interpretVcard(text);
  if (/BEGIN:VEVENT/i.test(trimmed) || /^BEGIN:VCALENDAR/i.test(trimmed))
    return interpretEvent(text);

  // A web link is only offered as clickable when it parses AND the scheme is
  // exactly http or https. javascript:, data:, file: and friends stay inert.
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:")
      return { text, kind: "url", label: "Web link", url: url.toString() };
  } catch {
    // Not a URL. Fall through to plain text.
  }

  return { text, kind: "text", label: "Plain text" };
}

/* -------------------------------------------------------------------------- */
/* Decoding                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Decode a single QR code out of a raw RGBA image buffer. jsQR is pure: it
 * scans the byte array and returns the payload or null, with no I/O. Throws a
 * typed error when the image is malformed or holds no readable code.
 */
export function decodeQr(image: ImageInput, opts?: Partial<QrOpts>): DecodeResult {
  if (!image || !image.data || !Number.isInteger(image.width) || !Number.isInteger(image.height))
    throw new ToolError(
      "bad-image",
      "That image could not be read as pixels.",
      "Pass an RGBA image buffer with matching width and height.",
    );
  if (image.width <= 0 || image.height <= 0)
    throw new ToolError(
      "empty-image",
      "The image has no width or height.",
      "Use a photo or screenshot that actually contains a QR code.",
    );
  if (image.data.length !== image.width * image.height * 4)
    throw new ToolError(
      "bad-image",
      "The pixel buffer does not match the image size.",
      "The data length must equal width x height x 4 (one RGBA pixel per four bytes).",
    );

  const found = jsQR(image.data, image.width, image.height, {
    inversionAttempts: opts?.inversion ?? "attemptBoth",
  });

  if (!found)
    throw new ToolError(
      "no-qr-found",
      "No QR code was found in this image.",
      "Fill the frame with the code, hold it flat and steady, and make sure it is well lit.",
    );

  return interpret(found.data);
}

/**
 * The generic tool contract. Custom panels call `decodeQr` directly for the
 * rich typed result; `run` flattens it to a labeled record so anything that
 * touches the logic generically still gets readable output.
 */
export function run(input: ImageInput, opts: QrOpts): Record<string, string> {
  const result = decodeQr(input, opts);
  const record: Record<string, string> = { Type: result.label, Text: result.text };
  for (const field of result.fields ?? []) record[field.label] = field.value;
  return record;
}

export default { run } satisfies ToolLogic<ImageInput, Record<string, string>, QrOpts>;
