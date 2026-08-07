import { ToolError, type ToolLogic } from '../types';

export type JsonToolsMode =
  | 'format'
  | 'minify'
  | 'validate'
  | 'jwt-decode'
  | 'base64-encode'
  | 'base64-decode'
  | 'url-encode'
  | 'url-decode';

export interface JsonToolsOpts {
  /** Which transform to run. */
  mode: string;
  /** Indent for `format` mode: '2' | '4' | 'tab'. */
  indent?: string;
  [key: string]: unknown;
}

export type JsonToolsResult = string | Record<string, string>;

/* ------------------------------------------------------------------ *
 * JSON parse errors
 * ------------------------------------------------------------------ */

export interface ParseFailure {
  /** The engine's reason, with its trailing position clause stripped. */
  reason: string;
  /** Character offset into the input, when the engine reported one. */
  position?: number;
  line?: number;
  column?: number;
}

/**
 * V8 phrases JSON parse errors as
 *   `Expected ',' or '}' after property value in JSON at position 12 (line 2 column 5)`
 * but the wording drifts between releases, so pull the offset out and rebuild
 * the sentence ourselves instead of forwarding the raw string.
 */
function describeParseError(err: unknown, source: string): ParseFailure {
  const raw = err instanceof Error ? err.message : String(err);
  const m = /position (\d+)/.exec(raw);
  if (!m) return { reason: raw };

  const position = Number(m[1]);
  const reason = raw
    .replace(/\s+in JSON at position \d+.*$/, '')
    .replace(/\s+at position \d+.*$/, '')
    .trim();

  const before = source.slice(0, position);
  const line = before.split('\n').length;
  const column = position - (before.lastIndexOf('\n') + 1) + 1;
  return { reason, position, line, column };
}

const JSON_FIX =
  'Check for a trailing comma, a missing comma or brace, unquoted keys, or single quotes where JSON requires double quotes.';

/** Parse, or throw a ToolError that says exactly where the document broke. */
function parseJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch (err) {
    const f = describeParseError(err, source);
    const where =
      f.position === undefined
        ? ''
        : ` at position ${f.position} (line ${f.line}, column ${f.column})`;
    throw new ToolError('invalid-json', `${f.reason}${where}.`, JSON_FIX);
  }
}

function indentOf(indent: string | undefined): string | number {
  switch (indent ?? '2') {
    case 'tab':
      return '\t';
    case '4':
      return 4;
    case '2':
      return 2;
    default:
      throw new ToolError('bad-indent', `Unknown indent "${indent}".`, 'Use one of: 2, 4, tab.');
  }
}

/* ------------------------------------------------------------------ *
 * base64 (unicode-safe)
 * ------------------------------------------------------------------ */

function bytesToBinary(bytes: Uint8Array): string {
  // Chunked — spreading a large Uint8Array into fromCharCode blows the stack.
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

export function base64Encode(text: string): string {
  return btoa(bytesToBinary(new TextEncoder().encode(text)));
}

/** Decode strict base64 to bytes. `label` names the thing being decoded. */
function base64ToBytes(raw: string, label: string): Uint8Array {
  const cleaned = raw.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
    throw new ToolError(
      'invalid-base64',
      `The ${label} is not valid base64.`,
      'Base64 uses A-Z, a-z, 0-9, + and /, padded with = to a multiple of 4 characters. For base64url input (- and _), use the JWT decoder.',
    );
  }
  let binary: string;
  try {
    binary = atob(cleaned);
  } catch {
    throw new ToolError(
      'invalid-base64',
      `The ${label} is not valid base64.`,
      'Remove any stray characters and make sure the padding is correct.',
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToText(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ToolError(
      'invalid-utf8',
      `The ${label} decodes to bytes that are not valid UTF-8 text.`,
      'This looks like binary data (an image or archive) rather than text: decode it with a file tool instead.',
    );
  }
}

export function base64Decode(raw: string): string {
  return bytesToText(base64ToBytes(raw, 'input'), 'input');
}

/* ------------------------------------------------------------------ *
 * JWT
 * ------------------------------------------------------------------ */

function base64UrlToText(part: string, label: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) {
    throw new ToolError(
      'invalid-jwt',
      `The JWT ${label} is not valid base64url.`,
      'base64url uses A-Z, a-z, 0-9, - and _ with no padding. Check that the token was copied in full.',
    );
  }
  const padded =
    part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4);
  return bytesToText(base64ToBytes(padded, `JWT ${label}`), `JWT ${label}`);
}

function jwtSection(part: string, label: string): Record<string, unknown> {
  const text = base64UrlToText(part, label);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const f = describeParseError(err, text);
    throw new ToolError(
      'invalid-jwt',
      `The JWT ${label} decoded, but it is not valid JSON: ${f.reason}.`,
      'JWT headers and payloads must be base64url-encoded JSON objects. The token may be truncated.',
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ToolError(
      'invalid-jwt',
      `The JWT ${label} is valid JSON but not a JSON object.`,
      'A JWT header and payload must each be a JSON object.',
    );
  }
  return parsed as Record<string, unknown>;
}

function isoFromClaim(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const d = new Date(value * 1000);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

/**
 * Decode (never verify) a JWT: header, payload, signature, plus humanized
 * time claims. Signature verification needs the secret and is out of scope —
 * treat the payload as untrusted.
 */
export function decodeJwt(token: string): Record<string, string> {
  const parts = token.trim().split('.');
  if (parts.length !== 3) {
    throw new ToolError(
      'invalid-jwt',
      `A JWT has 3 dot-separated parts (header.payload.signature); this token has ${parts.length}.`,
      'Paste the whole token, without the "Bearer " prefix and without line breaks.',
    );
  }
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];
  if (!rawHeader)
    throw new ToolError('invalid-jwt', 'The JWT header is empty.', 'Paste the whole token.');
  if (!rawPayload)
    throw new ToolError('invalid-jwt', 'The JWT payload is empty.', 'Paste the whole token.');

  const header = jwtSection(rawHeader, 'header');
  const payload = jwtSection(rawPayload, 'payload');

  const out: Record<string, string> = {
    Algorithm: typeof header.alg === 'string' ? header.alg : '(not specified)',
    Type: typeof header.typ === 'string' ? header.typ : '(not specified)',
    Header: JSON.stringify(header, null, 2),
    Payload: JSON.stringify(payload, null, 2),
  };

  const times: [string, string][] = [
    ['iat', 'Issued at (iat)'],
    ['nbf', 'Not before (nbf)'],
    ['exp', 'Expires (exp)'],
  ];
  for (const [claim, label] of times) {
    if (!(claim in payload)) continue;
    const iso = isoFromClaim(payload[claim]);
    out[label] = iso ?? `(unreadable: ${JSON.stringify(payload[claim])})`;
  }

  out.Signature = rawSignature || '(none: unsecured token)';
  out['Signature verified'] = 'no: this tool decodes only, it does not check the signature';
  return out;
}

/* ------------------------------------------------------------------ *
 * validate
 * ------------------------------------------------------------------ */

function rootTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Invalid JSON here is a *result*, not an error — that is the point of the mode. */
export function validateJson(source: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    const f = describeParseError(err, source);
    const out: Record<string, string> = { Valid: 'no', Error: f.reason };
    if (f.position !== undefined) {
      out.Position = String(f.position);
      out.Line = String(f.line);
      out.Column = String(f.column);
      const snippet = source
        .slice(Math.max(0, f.position - 20), f.position + 20)
        .replace(/\n/g, '\\n');
      out.Near = snippet;
    }
    out.Fix = JSON_FIX;
    return out;
  }

  const out: Record<string, string> = {
    Valid: 'yes',
    'Root type': rootTypeOf(parsed),
  };
  if (Array.isArray(parsed)) out.Items = String(parsed.length);
  else if (parsed !== null && typeof parsed === 'object')
    out['Top-level keys'] = String(Object.keys(parsed as object).length);
  out['Minified size'] = `${JSON.stringify(parsed).length} characters`;
  return out;
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

export function run(input: string, opts: JsonToolsOpts): JsonToolsResult {
  const mode = (opts?.mode || 'format') as JsonToolsMode;
  const raw = input ?? '';

  if (!raw.trim()) {
    throw new ToolError(
      'empty-input',
      'Enter some input to process.',
      mode.startsWith('base64') || mode.startsWith('url')
        ? 'Paste the text you want to encode or decode.'
        : 'Paste a JSON document or a JWT into the input box.',
    );
  }

  switch (mode) {
    case 'format':
      return JSON.stringify(parseJson(raw), null, indentOf(opts.indent));
    case 'minify':
      return JSON.stringify(parseJson(raw));
    case 'validate':
      return validateJson(raw);
    case 'jwt-decode':
      return decodeJwt(raw);
    case 'base64-encode':
      return base64Encode(raw);
    case 'base64-decode':
      return base64Decode(raw);
    case 'url-encode':
      return encodeURIComponent(raw);
    case 'url-decode':
      try {
        return decodeURIComponent(raw);
      } catch {
        throw new ToolError(
          'invalid-url-encoding',
          'The input contains a malformed percent-escape.',
          'Every % must be followed by two hex digits (e.g. %20). Escape a literal percent sign as %25.',
        );
      }
    default:
      throw new ToolError(
        'unknown-mode',
        `Unknown mode "${String(opts.mode)}".`,
        'Pick one of: format, minify, validate, jwt-decode, base64-encode, base64-decode, url-encode, url-decode.',
      );
  }
}

export default { run } satisfies ToolLogic<string, JsonToolsResult, JsonToolsOpts>;
