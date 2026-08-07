import QRCode from "qrcode";
import { ToolError, type ToolLogic } from "../types";

export interface QrOpts {
  /**
   * Payload shape. Backward compatible values: 'text' | 'url' | 'wifi' |
   * 'vcard'. Added in v2: 'email' | 'sms' | 'phone' | 'geo' | 'event'.
   */
  preset: string;
  /** Error correction level: 'L' | 'M' | 'Q' | 'H'. */
  ecc: string;
  /** Quiet-zone width in modules. */
  margin: number;
  /** Dark module colour as #rgb or #rrggbb. Defaults to black. */
  color?: string;
  /** Light module colour as #rgb or #rrggbb. Defaults to white. */
  background?: string;
  /** Optional rendered width in pixels, written to the SVG width/height. */
  width?: number;
  [key: string]: unknown;
}

const ECC_LEVELS = ["L", "M", "Q", "H"] as const;
type EccLevel = (typeof ECC_LEVELS)[number];

/** Every payload shape the tool can build. */
export const CONTENT_TYPES = [
  "text",
  "url",
  "wifi",
  "vcard",
  "email",
  "sms",
  "phone",
  "geo",
  "event",
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

const TYPE_LIST = "text, url, wifi, vcard, email, sms, phone, geo or event";

/* -------------------------------------------------------------------------- */
/* Escaping                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Escape a value for the WIFI: payload grammar. Backslash, semicolon, comma,
 * colon and double quote are the reserved characters; a single-pass regex
 * avoids the double-escaping bug you get from chained replaces.
 */
export function escapeWifi(value: string): string {
  return value.replace(/[\\;,:"]/g, (c) => `\\${c}`);
}

/**
 * Escape a vCard 4.0 property value (RFC 6350 section 3.4): backslash,
 * semicolon and comma are escaped, and real newlines become the two character
 * sequence \n.
 */
export function escapeVcard(value: string): string {
  return value.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, "\\n");
}

/**
 * Escape an iCalendar TEXT value (RFC 5545 section 3.3.11). Same reserved set
 * as vCard, which is unsurprising: both descend from the same content line
 * grammar.
 */
export function escapeIcal(value: string): string {
  return value.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, "\\n");
}

const encoder = new TextEncoder();

/**
 * Fold one content line to 75 octets (RFC 5545 section 3.1, RFC 6350 section
 * 3.2). Continuation lines start with a single space, and that space counts
 * toward the 75, so continuations carry 74 octets of content. Folding walks
 * code points rather than UTF-16 units so a multi byte character is never
 * split down the middle.
 */
export function foldLine(line: string, limit = 75): string {
  if (encoder.encode(line).length <= limit) return line;

  const out: string[] = [];
  let current = "";
  let used = 0;
  let budget = limit;

  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (used + size > budget) {
      out.push(current);
      current = "";
      used = 0;
      budget = limit - 1;
    }
    current += ch;
    used += size;
  }
  out.push(current);
  return out.join("\r\n ");
}

function foldAll(contentLines: string[]): string {
  return contentLines.map((l) => foldLine(l)).join("\r\n");
}

/* -------------------------------------------------------------------------- */
/* Payload builders                                                           */
/* -------------------------------------------------------------------------- */

export interface WifiFields {
  ssid: string;
  password?: string;
  /** WPA (covers WPA2 and WPA3), WEP, or nopass. Case insensitive. */
  security?: string;
  /** Set for a network that does not broadcast its SSID. */
  hidden?: boolean;
}

/**
 * Build a WIFI: join payload. The password field is omitted for open
 * networks, and H:true is only written for hidden networks so the common case
 * stays byte for byte what earlier versions produced.
 */
export function buildWifi(fields: WifiFields): string {
  const ssid = (fields.ssid ?? "").trim();
  if (!ssid)
    throw new ToolError(
      "missing-ssid",
      "The network name (SSID) is required.",
      "Enter the exact network name, matching upper and lower case.",
    );

  const raw = (fields.security ?? "").trim() || "WPA";
  const upper = raw.toUpperCase();
  const type =
    upper === "NOPASS" || upper === "NONE"
      ? "nopass"
      : upper === "WEP"
        ? "WEP"
        : upper === "WPA"
          ? "WPA"
          : "";
  if (!type)
    throw new ToolError(
      "bad-security",
      `Unknown Wi-Fi security type "${raw}".`,
      "Use WPA (covers WPA2/WPA3), WEP, or nopass for an open network.",
    );

  const parts = [`T:${type}`, `S:${escapeWifi(ssid)}`];
  if (type !== "nopass") parts.push(`P:${escapeWifi(fields.password ?? "")}`);
  if (fields.hidden) parts.push("H:true");
  return `WIFI:${parts.join(";")};;`;
}

export interface VcardFields {
  name: string;
  phone?: string;
  email?: string;
  org?: string;
  title?: string;
  url?: string;
  /** Free text address; written into the street component of ADR. */
  address?: string;
  note?: string;
}

/**
 * Build a vCard 4.0 contact card. Everything except the name is optional and
 * empty properties are dropped rather than written blank, which keeps the
 * payload short enough to stay scannable.
 */
export function buildVcard(fields: VcardFields): string {
  const name = (fields.name ?? "").trim();
  if (!name)
    throw new ToolError(
      "missing-name",
      "The contact name is required.",
      "Enter a name; every other contact field is optional.",
    );

  const words = name.split(/\s+/);
  const last = words.length > 1 ? words[words.length - 1]! : "";
  const first = words.length > 1 ? words.slice(0, -1).join(" ") : name;

  const out = [
    "BEGIN:VCARD",
    "VERSION:4.0",
    `N:${escapeVcard(last)};${escapeVcard(first)};;;`,
    `FN:${escapeVcard(name)}`,
  ];
  const push = (property: string, value: string | undefined) => {
    const v = (value ?? "").trim();
    if (v) out.push(`${property}:${escapeVcard(v)}`);
  };
  push("ORG", fields.org);
  push("TITLE", fields.title);
  if ((fields.phone ?? "").trim()) out.push(`TEL;TYPE=cell:${escapeVcard(fields.phone!.trim())}`);
  push("EMAIL", fields.email);
  push("URL", fields.url);
  const address = (fields.address ?? "").trim();
  if (address) out.push(`ADR;TYPE=work:;;${escapeVcard(address)};;;;`);
  push("NOTE", fields.note);
  out.push("END:VCARD");
  return foldAll(out);
}

export interface EmailFields {
  to: string;
  subject?: string;
  body?: string;
}

/**
 * Build a mailto: URL. Subject and body are percent encoded as query
 * parameters; the address itself keeps its @ so the payload stays readable.
 */
export function buildEmail(fields: EmailFields): string {
  const to = (fields.to ?? "").trim();
  if (!to)
    throw new ToolError(
      "missing-recipient",
      "The email address is required.",
      "Enter the address the scan should write to, for example hello@example.com.",
    );
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to))
    throw new ToolError(
      "invalid-email",
      `"${to}" is not a valid email address.`,
      "Use the full address including the domain, for example hello@example.com.",
    );

  const params: string[] = [];
  const subject = (fields.subject ?? "").trim();
  const body = fields.body ?? "";
  if (subject) params.push(`subject=${encodeURIComponent(subject)}`);
  if (body.trim()) params.push(`body=${encodeURIComponent(body)}`);
  return `mailto:${encodeURI(to)}${params.length ? `?${params.join("&")}` : ""}`;
}

/** Keep digits, a leading plus and the visual separators tel: allows. */
function normalisePhone(value: string, code: string, what: string): string {
  const raw = (value ?? "").trim().replace(/\s+/g, "");
  if (!raw)
    throw new ToolError(
      code,
      `The ${what} is required.`,
      "Enter the number in full, including the country code.",
    );
  if (!/^\+?[0-9().-]{3,}$/.test(raw) || !/[0-9]/.test(raw))
    throw new ToolError(
      code,
      `"${value}" is not a usable phone number.`,
      "Use digits with an optional leading +, for example +15550100.",
    );
  return raw;
}

export interface SmsFields {
  number: string;
  message?: string;
}

/**
 * Build an SMSTO: payload (the ZXing convention both major camera apps read).
 * The message is raw text, not percent encoded.
 */
export function buildSms(fields: SmsFields): string {
  const number = normalisePhone(fields.number, "missing-number", "phone number");
  const message = fields.message ?? "";
  return message.trim() ? `SMSTO:${number}:${message}` : `SMSTO:${number}`;
}

/** Build a tel: URL that dials on scan. */
export function buildPhone(number: string): string {
  return `tel:${normalisePhone(number, "missing-number", "phone number")}`;
}

export interface GeoFields {
  latitude: number | string;
  longitude: number | string;
}

/** Format a coordinate without exponent notation, which geo: does not allow. */
function formatCoordinate(value: number): string {
  const plain = Math.abs(value) < 1e-6 && value !== 0 ? value.toFixed(6) : String(value);
  return plain.includes("e") ? value.toFixed(6) : plain;
}

/** Build a geo: URI (RFC 5870) that opens a map pin on scan. */
export function buildGeo(fields: GeoFields): string {
  const lat = Number(String(fields.latitude ?? "").trim());
  const lng = Number(String(fields.longitude ?? "").trim());
  if (!Number.isFinite(lat) || !Number.isFinite(lng))
    throw new ToolError(
      "bad-coordinates",
      "Latitude and longitude must both be numbers.",
      "Paste the pair from a map app, for example 38.627 and -90.199.",
    );
  if (lat < -90 || lat > 90)
    throw new ToolError(
      "bad-latitude",
      `Latitude ${lat} is outside the range -90 to 90.`,
      "Check that you have not swapped latitude and longitude.",
    );
  if (lng < -180 || lng > 180)
    throw new ToolError(
      "bad-longitude",
      `Longitude ${lng} is outside the range -180 to 180.`,
      "Check that you have not swapped latitude and longitude.",
    );
  return `geo:${formatCoordinate(lat)},${formatCoordinate(lng)}`;
}

/**
 * Normalise an instant to the iCalendar UTC basic format (20260806T233000Z).
 * Accepts a Date, an already basic value, an ISO string carrying an offset,
 * or a bare "YYYY-MM-DDTHH:MM" which is read as UTC so the output never
 * depends on the machine's timezone.
 */
export function toIcalUtc(value: string | Date): string {
  const format = (d: Date) =>
    `${d
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "")}`;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime()))
      throw new ToolError(
        "bad-datetime",
        "That date and time could not be read.",
        "Pick the date again.",
      );
    return format(value);
  }

  const raw = String(value ?? "").trim();
  if (!raw)
    throw new ToolError(
      "missing-datetime",
      "The event start time is required.",
      "Pick a start date and time.",
    );
  if (/^\d{8}T\d{6}Z$/.test(raw)) return raw;

  const bare = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (bare) {
    const y = Number(bare[1]);
    const mo = Number(bare[2]);
    const d = Number(bare[3]);
    const hh = Number(bare[4]);
    const mm = Number(bare[5]);
    const ss = bare[6] ? Number(bare[6]) : 0;
    const date = new Date(Date.UTC(y, mo - 1, d, hh, mm, ss));
    const roundTrips =
      date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
    if (!roundTrips || hh > 23 || mm > 59 || ss > 59)
      throw new ToolError(
        "bad-datetime",
        `"${raw}" is not a real date and time.`,
        "Check the day of the month and the hour.",
      );
    return format(date);
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime()))
    throw new ToolError(
      "bad-datetime",
      `"${raw}" is not a date and time this tool can read.`,
      "Use YYYY-MM-DD HH:MM (read as UTC) or a full ISO timestamp.",
    );
  return format(parsed);
}

/** Small deterministic hash so an event gets a stable UID without randomness. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export interface EventFields {
  summary: string;
  /** Start instant. See toIcalUtc for the accepted forms. */
  start: string | Date;
  /** End instant. Defaults to the start (a zero length event). */
  end?: string | Date;
  location?: string;
  description?: string;
}

/**
 * Build a single VEVENT wrapped in a VCALENDAR. UID and DTSTAMP are required
 * by RFC 5545, so the UID is derived deterministically from the event content
 * (no clock, no randomness) and DTSTAMP mirrors the start.
 */
export function buildEvent(fields: EventFields): string {
  const summary = (fields.summary ?? "").trim();
  if (!summary)
    throw new ToolError(
      "missing-summary",
      "The event title is required.",
      "Enter a short title, for example Team standup.",
    );

  const start = toIcalUtc(fields.start);
  const end = fields.end ? toIcalUtc(fields.end) : start;
  if (end < start)
    throw new ToolError(
      "bad-time-range",
      "The event ends before it starts.",
      "Check the end date: an event that crosses midnight needs the next day.",
    );

  const location = (fields.location ?? "").trim();
  const description = (fields.description ?? "").trim();
  const uid = `${fnv1a([summary, start, end, location, description].join("|"))}@tools.maxhogan.dev`;

  const out = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//tools.maxhogan.dev//QR Code Generator//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${start}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${escapeIcal(summary)}`,
  ];
  if (location) out.push(`LOCATION:${escapeIcal(location)}`);
  if (description) out.push(`DESCRIPTION:${escapeIcal(description)}`);
  out.push("END:VEVENT", "END:VCALENDAR");
  return foldAll(out);
}

/** Validate and return a URL, keeping the error message actionable. */
export function buildUrl(input: string): string {
  const raw = (input ?? "").trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolError(
      "invalid-url",
      `"${raw}" is not a valid URL.`,
      "Include the scheme, e.g. https://example.com/page.",
    );
  }
  return url.toString();
}

/* -------------------------------------------------------------------------- */
/* Line based adapters (the string in, string out contract)                   */
/* -------------------------------------------------------------------------- */

function lines(input: string): string[] {
  return input.split(/\r?\n/).map((l) => l.trim());
}

function rest(all: string[], from: number): string {
  return all.slice(from).join("\n").trim();
}

/**
 * Build a WIFI: payload from lines: ssid, password, security, hidden.
 * The fourth line is optional and counts as hidden when it reads "hidden",
 * "true" or "yes".
 */
export function buildWifiPayload(input: string): string {
  const [ssid = "", password = "", security = "", hidden = ""] = lines(input);
  if (!ssid)
    throw new ToolError(
      "missing-ssid",
      "The first line must be the network name (SSID).",
      "Enter three lines: SSID, password, then WPA, WEP or nopass.",
    );
  return buildWifi({
    ssid,
    password,
    security,
    hidden: /^(hidden|true|yes)$/i.test(hidden),
  });
}

/**
 * Build a vCard from lines. The first four keep the order this tool has always
 * used (name, phone, email, organisation) so old shared links still decode the
 * same way; the newer fields are appended after them.
 */
export function buildVcardPayload(input: string): string {
  const all = lines(input);
  const [name = "", phone = "", email = "", org = "", title = "", url = "", address = ""] = all;
  if (!name)
    throw new ToolError(
      "missing-name",
      "The first line must be the contact name.",
      "Lines are: name, phone, email, organisation, title, website, address, note.",
    );
  return buildVcard({ name, phone, email, org, title, url, address, note: rest(all, 7) });
}

/** Build a mailto: payload from lines: address, subject, then the body. */
export function buildEmailPayload(input: string): string {
  const all = lines(input);
  const [to = "", subject = ""] = all;
  return buildEmail({ to, subject, body: rest(all, 2) });
}

/** Build an SMSTO: payload from lines: number, then the message. */
export function buildSmsPayload(input: string): string {
  const all = lines(input);
  return buildSms({ number: all[0] ?? "", message: rest(all, 1) });
}

/** Build a geo: payload from "lat,lng" on one line, or latitude then longitude. */
export function buildGeoPayload(input: string): string {
  const all = lines(input);
  const first = all[0] ?? "";
  if (first.includes(",")) {
    const [lat = "", lng = ""] = first.split(",");
    return buildGeo({ latitude: lat, longitude: lng });
  }
  return buildGeo({ latitude: first, longitude: all[1] ?? "" });
}

/** Build a calendar payload from lines: title, start, end, location, description. */
export function buildEventPayload(input: string): string {
  const all = lines(input);
  const [summary = "", start = "", end = "", location = ""] = all;
  return buildEvent({ summary, start, end: end || undefined, location, description: rest(all, 4) });
}

/** Turn the raw input into the string that actually gets encoded. */
export function buildPayload(input: string, preset: string): string {
  const raw = (input ?? "").trim();
  if (!raw)
    throw new ToolError(
      "empty-input",
      "Enter the text you want encoded in the QR code.",
      "Type a URL, a message, or pick a content type and fill in its fields.",
    );

  switch (preset) {
    case "url":
      return buildUrl(raw);
    case "wifi":
      return buildWifiPayload(raw);
    case "vcard":
      return buildVcardPayload(raw);
    case "email":
      return buildEmailPayload(raw);
    case "sms":
      return buildSmsPayload(raw);
    case "phone":
      return buildPhone(raw);
    case "geo":
      return buildGeoPayload(raw);
    case "event":
      return buildEventPayload(raw);
    case "text":
    case "":
      return raw;
    default:
      throw new ToolError("bad-preset", `Unknown preset "${preset}".`, `Choose ${TYPE_LIST}.`);
  }
}

/* -------------------------------------------------------------------------- */
/* Colour helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Parse #rgb or #rrggbb into 0-255 channels. Returns null when unparseable. */
export function parseHexColor(value: string): { r: number; g: number; b: number } | null {
  const raw = (value ?? "").trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(raw);
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(raw);
  if (short)
    return {
      r: parseInt(short[1]! + short[1]!, 16),
      g: parseInt(short[2]! + short[2]!, 16),
      b: parseInt(short[3]! + short[3]!, 16),
    };
  if (long)
    return {
      r: parseInt(long[1]!, 16),
      g: parseInt(long[2]!, 16),
      b: parseInt(long[3]!, 16),
    };
  return null;
}

/** Normalise a colour to #rrggbb, throwing a typed error on garbage. */
export function normaliseColor(value: string | undefined, fallback: string): string {
  const raw = (value ?? "").trim();
  if (!raw) return fallback;
  const rgb = parseHexColor(raw);
  if (!rgb)
    throw new ToolError(
      "bad-color",
      `"${raw}" is not a hex colour.`,
      "Use a value like #1d1b18 or #fff.",
    );
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}`;
}

/** WCAG relative luminance. Returns 0 for an unparseable colour. */
export function relativeLuminance(color: string): number {
  const rgb = parseHexColor(color);
  if (!rgb) return 0;
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** WCAG contrast ratio between two colours: 1 (identical) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}

/* -------------------------------------------------------------------------- */
/* Logo embedding and scannability                                            */
/* -------------------------------------------------------------------------- */

/** Smallest and largest logo width, as a fraction of the QR width. */
export const LOGO_MIN = 0.15;
export const LOGO_MAX = 0.25;
/** Above this fraction the code starts failing on cheap scanners. */
export const LOGO_SAFE = 0.2;
/** Below this contrast ratio scanners start missing the code. */
export const CONTRAST_MIN = 4;

export interface LogoEmbedOptions {
  /** The logo as a data URL. Never a remote URL: nothing is fetched. */
  dataUrl: string;
  /** Logo width as a fraction of the QR width. Clamped to 0.15 to 0.25. */
  size?: number;
  /** Pad around the logo, as a fraction of the logo size. Defaults to 0.08. */
  pad?: number;
  /** Pad fill colour. Defaults to white. */
  background?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): string {
  return String(Math.round(value * 1e4) / 1e4);
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Place a logo in the middle of a rendered QR SVG: a rounded pad in the
 * background colour, then the image on top. Error correction level H recovers
 * roughly 30% of the modules, which is what makes the covered area safe.
 */
export function embedLogoInSvg(svg: string, options: LogoEmbedOptions): string {
  const dataUrl = (options.dataUrl ?? "").trim();
  if (!dataUrl) return svg;
  if (!/^data:/i.test(dataUrl))
    throw new ToolError(
      "bad-logo",
      "The logo must be embedded data, not a link.",
      "Pick an image file: it is read on your device and inlined into the code.",
    );

  const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  const close = svg.lastIndexOf("</svg>");
  if (!box || close === -1)
    throw new ToolError(
      "bad-svg",
      "That QR code could not be measured for a logo overlay.",
      "Regenerate the code, then add the logo again.",
    );

  const width = Number(box[1]);
  const height = Number(box[2]);
  const size = clamp(options.size ?? LOGO_SAFE, 0.05, 0.35);
  const pad = clamp(options.pad ?? 0.08, 0, 0.5);
  const background = normaliseColor(options.background, "#ffffff");

  const logoW = width * size;
  const logoH = height * size;
  const padW = logoW * (1 + pad * 2);
  const padH = logoH * (1 + pad * 2);

  const overlay =
    `<rect x="${round((width - padW) / 2)}" y="${round((height - padH) / 2)}"` +
    ` width="${round(padW)}" height="${round(padH)}" rx="${round(padW * 0.15)}"` +
    ` fill="${background}"/>` +
    `<image x="${round((width - logoW) / 2)}" y="${round((height - logoH) / 2)}"` +
    ` width="${round(logoW)}" height="${round(logoH)}"` +
    ` preserveAspectRatio="xMidYMid meet" href="${escapeAttr(dataUrl)}"/>`;

  return `${svg.slice(0, close)}${overlay}${svg.slice(close)}`;
}

/** Error correction actually used: a logo covers modules, so it forces H. */
export function effectiveEcc(chosen: string, hasLogo: boolean): string {
  return hasLogo ? "H" : (chosen || "M").toUpperCase();
}

export interface ScannabilityInput {
  hasLogo?: boolean;
  logoSize?: number;
  color?: string;
  background?: string;
}

/**
 * Plain language warnings about anything that makes the code harder to scan.
 * Pure so the panel can render them without owning the thresholds.
 */
export function scannabilityWarnings(input: ScannabilityInput): string[] {
  const out: string[] = [];
  if (input.hasLogo && (input.logoSize ?? LOGO_SAFE) > LOGO_SAFE)
    out.push(
      "The logo covers more than 20% of the code. It will still scan on most phones, but test it before printing.",
    );
  const ratio = contrastRatio(input.color ?? "#000000", input.background ?? "#ffffff");
  if (ratio < CONTRAST_MIN)
    out.push(
      `Contrast between the two colours is low (${ratio.toFixed(1)} to 1). Darken the foreground or lighten the background.`,
    );
  return out;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function normaliseEcc(ecc: string): EccLevel {
  const level = (ecc || "M").toUpperCase();
  if (!(ECC_LEVELS as readonly string[]).includes(level))
    throw new ToolError(
      "bad-ecc",
      `Unknown error correction level "${ecc}".`,
      "Use L (7%), M (15%), Q (25%) or H (30%).",
    );
  return level as EccLevel;
}

function normaliseMargin(margin: number): number {
  const m = margin ?? 4;
  if (!Number.isFinite(m) || m < 0 || m > 20)
    throw new ToolError(
      "bad-margin",
      "Margin must be between 0 and 20 modules.",
      "The QR spec recommends a quiet zone of at least 4.",
    );
  return Math.floor(m);
}

export interface RenderOptions {
  ecc?: string;
  margin?: number;
  color?: string;
  background?: string;
  width?: number;
  /** Omit for a plain code. */
  logo?: LogoEmbedOptions;
}

/**
 * Encode an already built payload as SVG. Exported so a UI can compose its own
 * payload with the structured builders and still share one render path.
 */
export async function renderSvg(payload: string, options: RenderOptions = {}): Promise<string> {
  const errorCorrectionLevel = normaliseEcc(
    effectiveEcc(options.ecc ?? "M", Boolean(options.logo?.dataUrl)),
  );
  const margin = normaliseMargin(options.margin ?? 4);
  const dark = normaliseColor(options.color, "#000000");
  const light = normaliseColor(options.background, "#ffffff");

  let svg: string;
  try {
    svg = await QRCode.toString(payload, {
      type: "svg",
      errorCorrectionLevel,
      margin,
      color: { dark, light },
      ...(options.width ? { width: options.width } : {}),
    });
  } catch (e) {
    throw new ToolError(
      "encode-failed",
      `Could not encode this input as a QR code: ${(e as Error).message}`,
      "QR codes top out near 3 KB of data: shorten the input or lower the error correction level.",
    );
  }

  return options.logo?.dataUrl
    ? embedLogoInSvg(svg, { ...options.logo, background: options.logo.background ?? light })
    : svg;
}

export async function run(input: string, opts: QrOpts): Promise<string> {
  const payload = buildPayload(input, opts?.preset ?? "text");
  return renderSvg(payload, {
    ecc: opts?.ecc ?? "M",
    margin: opts?.margin ?? 4,
    color: opts?.color,
    background: opts?.background,
    width: opts?.width,
  });
}

export default { run } satisfies ToolLogic<string, string, QrOpts>;
