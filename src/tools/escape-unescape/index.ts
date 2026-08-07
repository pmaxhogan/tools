import { ToolError, type ToolLogic } from '../types';

export interface EscapeOpts {
  /** 'json' | 'html' | 'url' | 'regex' | 'shell' */
  format: string;
  /** 'escape' | 'unescape' */
  direction: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// JSON — string-literal escaping (no outer quotes).
// ---------------------------------------------------------------------------

function jsonEscape(str: string): string {
  // JSON.stringify always wraps in quotes; strip them to get the raw
  // escaped-content form the "json" format promises.
  return JSON.stringify(str).slice(1, -1);
}

function jsonUnescape(str: string): string {
  try {
    const parsed: unknown = JSON.parse(`"${str}"`);
    if (typeof parsed !== 'string') throw new Error('not a string');
    return parsed;
  } catch {
    throw new ToolError(
      'invalid-json-escape',
      `"${str}" is not valid JSON string-escaped text.`,
      'Check for unescaped quotes, raw control characters, or invalid \\ escape sequences.',
    );
  }
}

// ---------------------------------------------------------------------------
// HTML — named entities for the common set, numeric (decimal) fallback for
// everything else non-ASCII. Hand-rolled, no DOM.
// ---------------------------------------------------------------------------

/** name -> character, for the common HTML entities. Source of truth for both directions. */
const ENTITY_TO_CHAR: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
  copy: '\u00A9',
  reg: '\u00AE',
  trade: '\u2122',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D',
  eacute: '\u00E9',
  egrave: '\u00E8',
  ecirc: '\u00EA',
  agrave: '\u00E0',
  acirc: '\u00E2',
  ccedil: '\u00E7',
  ntilde: '\u00F1',
  uuml: '\u00FC',
  ouml: '\u00F6',
  auml: '\u00E4',
  szlig: '\u00DF',
  euro: '\u20AC',
  pound: '\u00A3',
  yen: '\u00A5',
  cent: '\u00A2',
  deg: '\u00B0',
  plusmn: '\u00B1',
  times: '\u00D7',
  divide: '\u00F7',
  frac12: '\u00BD',
  frac14: '\u00BC',
  frac34: '\u00BE',
  sect: '\u00A7',
  para: '\u00B6',
  middot: '\u00B7',
  bull: '\u2022',
  larr: '\u2190',
  rarr: '\u2192',
  uarr: '\u2191',
  darr: '\u2193',
  hearts: '\u2665',
  spades: '\u2660',
  clubs: '\u2663',
  diams: '\u2666',
  alpha: '\u03B1',
  beta: '\u03B2',
  gamma: '\u03B3',
  pi: '\u03C0',
  sum: '\u2211',
  infin: '\u221E',
  ne: '\u2260',
  le: '\u2264',
  ge: '\u2265',
  radic: '\u221A',
};

/** character -> entity name, derived from ENTITY_TO_CHAR (last writer wins on dupes, none expected). */
const CHAR_TO_ENTITY: Record<string, string> = {};
for (const [name, ch] of Object.entries(ENTITY_TO_CHAR)) {
  CHAR_TO_ENTITY[ch] = `&${name};`;
}

function htmlEscape(str: string): string {
  let out = '';
  for (const ch of str) {
    const named = CHAR_TO_ENTITY[ch];
    if (named) {
      out += named;
    } else if (ch.codePointAt(0)! > 127) {
      out += `&#${ch.codePointAt(0)};`;
    } else {
      out += ch;
    }
  }
  return out;
}

const HTML_ENTITY_RE = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;

function htmlUnescape(str: string): string {
  return str.replace(HTML_ENTITY_RE, (match, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code)) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const ch = ENTITY_TO_CHAR[body];
    return ch !== undefined ? ch : match;
  });
}

// ---------------------------------------------------------------------------
// URL — percent-encoding via the standard URI component codec.
// ---------------------------------------------------------------------------

function urlEscape(str: string): string {
  return encodeURIComponent(str);
}

function urlUnescape(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch {
    throw new ToolError(
      'invalid-url-escape',
      `"${str}" contains a malformed percent-encoding sequence.`,
      'Make sure every % is followed by two hex digits and the encoded bytes form valid UTF-8.',
    );
  }
}

// ---------------------------------------------------------------------------
// Regex — escape metacharacters so the string matches itself literally.
// ---------------------------------------------------------------------------

const REGEX_METACHARS = /[.*+?^${}()|[\]\\]/g;
const REGEX_ESCAPED = /\\([.*+?^${}()|[\]\\])/g;

function regexEscape(str: string): string {
  return str.replace(REGEX_METACHARS, '\\$&');
}

function regexUnescape(str: string): string {
  return str.replace(REGEX_ESCAPED, '$1');
}

// ---------------------------------------------------------------------------
// Shell — POSIX single-quote escaping (the '\'' dance).
// ---------------------------------------------------------------------------

function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

function shellUnescape(str: string): string {
  let s = str;
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    s = s.slice(1, -1);
  }
  return s.replace(/'\\''/g, "'");
}

// ---------------------------------------------------------------------------

const FORMATS: Record<string, { escape: (s: string) => string; unescape: (s: string) => string }> =
  {
    json: { escape: jsonEscape, unescape: jsonUnescape },
    html: { escape: htmlEscape, unescape: htmlUnescape },
    url: { escape: urlEscape, unescape: urlUnescape },
    regex: { escape: regexEscape, unescape: regexUnescape },
    shell: { escape: shellEscape, unescape: shellUnescape },
  };

export function run(input: string, opts: EscapeOpts): string {
  const text = input ?? '';
  // Empty input is a no-op in both directions for every format — there is
  // nothing to escape or decode, and this keeps behavior consistent across
  // formats (rather than e.g. shell producing `''` for empty input).
  if (text === '') return '';

  const format = FORMATS[opts.format];
  if (!format)
    throw new ToolError(
      'bad-format',
      `Unknown format "${opts.format}".`,
      'Use one of: json, html, url, regex, shell.',
    );

  if (opts.direction === 'unescape') return format.unescape(text);
  if (opts.direction === 'escape') return format.escape(text);
  throw new ToolError(
    'bad-direction',
    `Unknown direction "${opts.direction}".`,
    'Use "escape" or "unescape".',
  );
}

export default { run } satisfies ToolLogic<string, string, EscapeOpts>;
